import type { SkillUpdateStatus } from "@ling/contracts/skill";
import { toError } from "@ling/core/ling-error";
import { readGlobalSkillUpdateEntries, type SkillLockEntry } from "@ling/core/skills/skill-lock";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import pLimit from "p-limit";

/** One slow GitHub request fails after 15 seconds without discarding other repositories. */
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
/** Four repository checks bound GitHub requests and local hashing I/O. */
const GITHUB_FETCH_CONCURRENCY = 4;

function blobSha(content: Buffer): Buffer {
	return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest();
}

async function fileBlobSha(path: string, size: number): Promise<Buffer> {
	const hash = createHash("sha1").update(`blob ${size}\0`);
	let bytesRead = 0;
	for await (const chunk of createReadStream(path)) {
		if (!Buffer.isBuffer(chunk)) throw new Error(`Installed skill file did not yield binary content: ${path}`);
		bytesRead += chunk.length;
		hash.update(chunk);
	}
	if (bytesRead !== size) throw new Error(`Installed skill file changed while hashing: ${path}`);
	return hash.digest();
}

/**
 * Git's own tree hash of a directory, so the result is byte-comparable with the hashes GitHub
 * reports and the `skills` CLI records. Empty directories return null (git does not track them).
 * `.git` and `.DS_Store` are skipped: neither exists in the upstream tree.
 */
async function gitTreeSha(dir: string): Promise<Buffer | null> {
	const dirents = await readdir(dir, { withFileTypes: true });
	const rows: { sortKey: Buffer; record: Buffer }[] = [];
	for (const dirent of dirents) {
		if (dirent.name === ".git" || dirent.name === ".DS_Store") continue;
		const full = join(dir, dirent.name);
		let mode: string;
		let sha: Buffer;
		if (dirent.isSymbolicLink()) {
			mode = "120000";
			sha = blobSha(Buffer.from(await readlink(full)));
		} else if (dirent.isDirectory()) {
			const sub = await gitTreeSha(full);
			if (sub === null) continue;
			mode = "40000";
			sha = sub;
		} else if (dirent.isFile()) {
			const info = await stat(full);
			if (!info.isFile()) throw new Error(`Installed skill path is not a regular file: ${full}`);
			mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
			sha = await fileBlobSha(full, info.size);
		} else {
			throw new Error(`Installed skill path is not a regular file, directory, or symbolic link: ${full}`);
		}
		// Git sorts tree entries byte-wise with directory names compared as "name/".
		rows.push({
			sortKey: Buffer.from(mode === "40000" ? `${dirent.name}/` : dirent.name),
			record: Buffer.concat([Buffer.from(`${mode} ${dirent.name}\0`), sha]),
		});
	}
	if (rows.length === 0) return null;
	rows.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
	const body = Buffer.concat(rows.map((row) => row.record));
	return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest();
}

type LocalFolderHash =
	{ kind: "missing" } | { kind: "present"; hash: string | null } | { kind: "error"; reason: string };

async function localFolderHash(dir: string): Promise<LocalFolderHash> {
	try {
		const info = await stat(dir);
		if (!info.isDirectory()) throw new Error(`Installed skill path is not a directory: ${dir}`);
	} catch (error) {
		if ((toError(error) as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "error", reason: toError(error).message };
	}
	try {
		const sha = await gitTreeSha(dir);
		return { kind: "present", hash: sha === null ? null : sha.toString("hex") };
	} catch (error) {
		return { kind: "error", reason: toError(error).message };
	}
}

/** One trees-API call per repository; returns path → tree sha for every directory in it. */
async function fetchRepoTreeShas(source: string, ref: string | null): Promise<Map<string, string>> {
	const url = `https://api.github.com/repos/${source}/git/trees/${encodeURIComponent(ref ?? "HEAD")}?recursive=1`;
	const response = await fetch(url, {
		headers: { accept: "application/vnd.github+json", "user-agent": "ling-skill-updates" },
		signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`GitHub API responded ${response.status} for ${source}`);
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error(`GitHub API returned an invalid tree payload for ${source}`);
	}
	const { tree, truncated } = payload as { tree?: unknown; truncated?: unknown };
	if (!Array.isArray(tree) || typeof truncated !== "boolean") {
		throw new Error(`GitHub API returned an invalid tree payload for ${source}`);
	}
	if (truncated) throw new Error(`GitHub API tree response was truncated for ${source}`);
	const shas = new Map<string, string>();
	for (const value of tree) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`GitHub API returned an invalid tree node for ${source}`);
		}
		const node = value as { path?: unknown; type?: unknown; sha?: unknown };
		if (typeof node.path !== "string" || typeof node.type !== "string" || typeof node.sha !== "string") {
			throw new Error(`GitHub API returned an invalid tree node for ${source}`);
		}
		if (node.type === "tree") {
			shas.set(node.path, node.sha);
		}
	}
	return shas;
}

/** Mirrors the CLI's reasons for skills its update command cannot check. */
function skipReason(entry: SkillLockEntry): string {
	if (entry.sourceType === "local") return "local path install";
	if (entry.sourceType === "git") return "generic git URL";
	if (entry.sourceType === "well-known") return "well-known source";
	if (!/^[0-9a-f]{40}$/i.test(entry.skillFolderHash)) return "no version tracking";
	return "no skill path recorded";
}

export async function checkGlobalSkillUpdates(globalSkillsDir: string): Promise<SkillUpdateStatus[]> {
	const { entries, invalidStatuses } = readGlobalSkillUpdateEntries();
	const statuses: SkillUpdateStatus[] = [...invalidStatuses];
	const checkable: SkillLockEntry[] = [];
	for (const entry of entries) {
		if (
			entry.sourceType === "github" &&
			entry.skillPath &&
			entry.source &&
			/^[0-9a-f]{40}$/i.test(entry.skillFolderHash)
		) {
			checkable.push(entry);
			continue;
		}
		statuses.push({
			name: entry.name,
			source: entry.source,
			status: "unknown",
			dirty: null,
			reason: skipReason(entry),
		});
	}

	const bySource = Map.groupBy(checkable, (entry) => `${entry.source}\0${entry.ref ?? ""}`);
	const limit = pLimit(GITHUB_FETCH_CONCURRENCY);
	await limit.map(bySource.values(), async (group) => {
		const [first] = group;
		if (!first) return;
		let treeResult: { ok: true; shas: Map<string, string> } | { ok: false; reason: string };
		try {
			treeResult = { ok: true, shas: await fetchRepoTreeShas(first.source, first.ref) };
		} catch (error) {
			treeResult = { ok: false, reason: toError(error).message };
		}
		for (const entry of group) {
			const local = await localFolderHash(join(globalSkillsDir, entry.name));
			// Not installed into Pi's global skills directory (the CLI may have installed it
			// for another agent only) — nothing Ling can meaningfully offer to update.
			if (local.kind === "missing") continue;
			if (local.kind === "error") {
				statuses.push({
					name: entry.name,
					source: entry.source,
					status: "error",
					dirty: null,
					reason: local.reason,
				});
				continue;
			}
			const dirty = local.hash === null || local.hash.toLowerCase() !== entry.skillFolderHash.toLowerCase();
			if (!treeResult.ok) {
				statuses.push({
					name: entry.name,
					source: entry.source,
					status: "error",
					dirty,
					reason: treeResult.reason,
				});
				continue;
			}
			const latest = treeResult.shas.get(posix.dirname(entry.skillPath));
			if (latest === undefined) {
				statuses.push({
					name: entry.name,
					source: entry.source,
					status: "error",
					dirty,
					reason: "deleted upstream",
				});
				continue;
			}
			statuses.push({
				name: entry.name,
				source: entry.source,
				status: latest.toLowerCase() === entry.skillFolderHash.toLowerCase() ? "up-to-date" : "update-available",
				dirty,
				reason: null,
			});
		}
	});
	return statuses.sort((a, b) => a.name.localeCompare(b.name));
}
