import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { SESSION_TRANSFER_MAX_BYTES } from "@ling/contracts/session-inspection";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLingError } from "../../ling-error";

function prepareSessionImport(content: string, cwd: string): { name: string; content: string } {
	const invalid = () =>
		createLingError({
			code: "INVALID_REQUEST",
			category: "validation",
			retryable: false,
			message: "Choose a valid Pi session JSONL file. Every nonempty line must contain a complete record.",
		});
	const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
	let header: Record<string, unknown> | undefined;
	for (const [index, line] of lines.entries()) {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			throw invalid();
		}
		if (entry === null || typeof entry !== "object" || Array.isArray(entry) || !("type" in entry)) throw invalid();
		if (typeof entry.type !== "string" || (index > 0 && entry.type === "session")) throw invalid();
		if (index === 0) header = entry;
	}
	if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) throw invalid();
	if (
		header.version !== undefined &&
		(typeof header.version !== "number" ||
			!Number.isInteger(header.version) ||
			header.version < 1 ||
			header.version > CURRENT_SESSION_VERSION)
	)
		throw invalid();
	// Imported histories get an SDK-generated identity so sidebar, drafts and files retain independent owners.
	const id = SessionManager.inMemory(cwd).getSessionId();
	lines[0] = JSON.stringify({ ...header, id, cwd });
	return { name: `${id}.jsonl`, content: `${lines.join("\n")}\n` };
}

/** Validate the migrated graph before any SDK traversal follows parent pointers. */
function validateSessionTree(manager: SessionManager): void {
	const parents = new Map<string, string | null>();
	for (const entry of manager.getEntries()) {
		if (
			typeof entry.id !== "string" ||
			!entry.id ||
			parents.has(entry.id) ||
			(entry.parentId !== null && (typeof entry.parentId !== "string" || !entry.parentId))
		)
			throw new Error("Session entries require unique identities and valid parent identities.");
		parents.set(entry.id, entry.parentId);
	}
	const complete = new Set<string>();
	for (const id of parents.keys()) {
		const branch = new Set<string>();
		let current: string | null = id;
		while (current !== null && !complete.has(current)) {
			if (branch.has(current)) throw new Error("Session parent references contain a cycle.");
			if (!parents.has(current)) throw new Error("Session parent references contain a missing entry.");
			branch.add(current);
			current = parents.get(current)!;
		}
		for (const visited of branch) complete.add(visited);
	}
}

/** Owns import validation, identity assignment and temporary-file lifetime before replacing a session. */
export async function importPiSession(
	content: string,
	cwd: string,
	apply: (path: string) => Promise<{ cancelled: boolean }>,
): Promise<{ cancelled: boolean }> {
	if (Buffer.byteLength(content) > SESSION_TRANSFER_MAX_BYTES)
		throw new Error("Session import exceeds the 8 MiB limit");
	const prepared = prepareSessionImport(content, cwd);
	const directory = await mkdtemp(join(tmpdir(), "ling-session-import-"));
	try {
		const path = join(directory, prepared.name);
		await writeFile(path, prepared.content, { mode: 0o600 });
		try {
			const manager = SessionManager.open(path, directory);
			validateSessionTree(manager);
			manager.buildSessionContext();
		} catch (cause) {
			throw createLingError(
				{
					code: "INVALID_REQUEST",
					category: "validation",
					retryable: false,
					message: "Pi could not read this session's history. The current session is unchanged.",
				},
				cause,
			);
		}
		return await apply(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
