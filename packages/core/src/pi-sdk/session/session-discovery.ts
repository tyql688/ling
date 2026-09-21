import { getAgentDir, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { errorCode } from "@ling/contracts/ling-error";
import { isRecord } from "@ling/contracts/records";
import { pathIdentity } from "@ling/core/paths";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { PiSessionInfo } from "../types";
import { createSessionOriginReader } from "./session-origin";

type LingSessionInfo = PiSessionInfo & { manualFork: boolean };

/** Stable file identity used by the persisted sidebar-summary cache. */
interface PiSessionFileFingerprint {
	size: number;
	modifiedAtMs: number;
}

interface CachedPiSessionFile {
	path: string;
	fingerprint: PiSessionFileFingerprint;
}

type PiSessionDiscovery =
	| { kind: "cached"; path: string; fingerprint: PiSessionFileFingerprint }
	| {
			kind: "loaded";
			path: string;
			info: LingSessionInfo;
			/** Null when the file changed while it was being read; do not persist that projection. */
			fingerprint: PiSessionFileFingerprint | null;
	  };

/** Limits simultaneous JSONL streams without retaining Pi's unused all-message search corpus. */
const SESSION_DISCOVERY_CONCURRENCY = 8;

export function listPiSessions(cwd: string): Promise<PiSessionInfo[]> {
	return SessionManager.list(cwd);
}

function defaultPiSessionDirectory(cwd: string): string {
	// Pi 0.83's public SessionManager.list() owns the same default directory convention,
	// but does not export the resolver from its package root. Keep the adapter detail here.
	const safePath = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(resolve(getAgentDir()), "sessions", safePath);
}

function fileFingerprint(stats: { size: number; mtimeMs: number }): PiSessionFileFingerprint {
	return { size: stats.size, modifiedAtMs: stats.mtimeMs };
}

function sameFingerprint(left: PiSessionFileFingerprint, right: PiSessionFileFingerprint): boolean {
	return left.size === right.size && left.modifiedAtMs === right.modifiedAtMs;
}

function messageText(message: unknown): string | null {
	if (typeof message !== "object" || message === null || !("content" in message)) return null;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return content
		.flatMap((block) => {
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				return [block.text];
			}
			return [];
		})
		.join(" ");
}

function hasMessageContent(message: unknown): message is { content: unknown } {
	return typeof message === "object" && message !== null && "content" in message;
}

function messageRole(message: unknown): string | null {
	return typeof message === "object" && message !== null && "role" in message && typeof message.role === "string"
		? message.role
		: null;
}

function messageTimestamp(message: unknown, entryTimestamp: unknown): number | null {
	if (typeof message !== "object" || message === null) return null;
	if ("timestamp" in message && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
		const timestamp = new Date(message.timestamp).getTime();
		return Number.isFinite(timestamp) ? timestamp : null;
	}
	if (typeof entryTimestamp !== "string") return null;
	const timestamp = new Date(entryTimestamp).getTime();
	return Number.isFinite(timestamp) ? timestamp : null;
}

async function inspectPiSessionFile(
	path: string,
	initialFingerprint: PiSessionFileFingerprint,
): Promise<PiSessionDiscovery | null> {
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let header: { id: string; timestamp: unknown; cwd?: unknown; parentSession?: unknown } | null = null;
	let origin: ReturnType<typeof createSessionOriginReader> | null = null;
	let messageCount = 0;
	let firstMessage = "";
	let name: string | undefined;
	let lastActivityTime: number | null = null;

	try {
		for await (const line of lines) {
			const [entry] = parseSessionEntries(line) as unknown[];
			if (!entry) continue;
			if (!isRecord(entry)) {
				if (header === null) return null;
				continue;
			}
			if (header === null) {
				if (entry.type !== "session" || typeof entry.id !== "string") return null;
				header = {
					id: entry.id,
					timestamp: entry.timestamp,
					...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
					...(entry.parentSession !== undefined ? { parentSession: entry.parentSession } : {}),
				};
				origin = createSessionOriginReader(header);
				continue;
			}
			origin?.read(entry);
			if (entry.type === "session_info") {
				name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
			}
			if (entry.type !== "message") continue;
			messageCount += 1;
			const message = entry.message;
			const role = messageRole(message);
			if (role !== "user" && role !== "assistant") continue;
			if (!hasMessageContent(message)) continue;
			const activityTime = messageTimestamp(message, entry.timestamp);
			if (activityTime !== null) lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			// The sidebar only needs the first user preview. Avoid reconstructing every
			// later assistant/tool transcript string while scanning large session files.
			if (!firstMessage && role === "user") {
				const text = messageText(message);
				if (text) firstMessage = text;
			}
		}
		if (header === null || origin === null) return null;
		const createdAt = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
		const created = Number.isFinite(createdAt) ? new Date(createdAt) : new Date(initialFingerprint.modifiedAtMs);
		const modified = new Date(lastActivityTime ?? created.getTime());
		const finalStats = await stat(path);
		const finalFingerprint = fileFingerprint(finalStats);
		const stableFingerprint = sameFingerprint(initialFingerprint, finalFingerprint) ? finalFingerprint : null;
		const info: LingSessionInfo = {
			path,
			id: header.id,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			...(name !== undefined ? { name } : {}),
			...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
			manualFork: origin.result().manualFork,
			created,
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			// Ling projects only title/preview/count; retaining every message made startup
			// proportional to the complete transcript corpus for no renderer benefit.
			allMessagesText: "",
		};
		return { kind: "loaded", path, info, fingerprint: stableFingerprint };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	} finally {
		lines.close();
		input.destroy();
	}
}

/**
 * Enumerates one project's default Pi session directory and reuses summaries whose
 * size/mtime fingerprint is unchanged. Only new or changed JSONL files are streamed.
 */
export async function discoverPiSessions(
	cwd: string,
	cachedFiles: readonly CachedPiSessionFile[],
): Promise<PiSessionDiscovery[]> {
	const directory = defaultPiSessionDirectory(cwd);
	let names: string[];
	try {
		names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const cachedByPath = new Map(cachedFiles.map((entry) => [pathIdentity(entry.path), entry]));
	const files = names.map((name) => join(directory, name));
	const results = new Array<PiSessionDiscovery | null>(files.length).fill(null);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < files.length) {
			const index = nextIndex;
			nextIndex += 1;
			const path = files[index];
			if (!path) continue;
			try {
				const fingerprint = fileFingerprint(await stat(path));
				const cached = cachedByPath.get(pathIdentity(path));
				results[index] =
					cached && sameFingerprint(cached.fingerprint, fingerprint)
						? { kind: "cached", path, fingerprint }
						: await inspectPiSessionFile(path, fingerprint);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
		}
	};
	const workerCount = Math.min(SESSION_DISCOVERY_CONCURRENCY, files.length);
	await Promise.all(Array.from({ length: workerCount }, worker));
	return results.filter((result): result is PiSessionDiscovery => result !== null);
}
