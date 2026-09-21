import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import { isRecord as isDatasetRecord } from "@ling/contracts/records";
import {
	type ComposerHistoryEntry,
	type ComposerHistoryStatus,
	type ListComposerHistoryRequest,
	SESSION_COMPOSER_HISTORY_MAX_ITEMS,
	SESSION_MESSAGE_TEXT_MAX_CHARS,
} from "@ling/contracts/session";
import { requestCancelled } from "@ling/core/ling-error";
import { readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import { datasetCorruption, inspectDatasetVersion, parseDatasetJson } from "@ling/host/storage/dataset-envelope";
import { join } from "node:path";
import type { HostDatabase } from "../../storage/database";

/** Persistent file name under userData; decoupled from the dataset schema — renaming loses history. */
const COMPOSER_HISTORY_FILE = "composer-history.jsonl";
/** Dataset schema identifier; validated when reading from disk to prevent cross-reading other JSONL. */
const COMPOSER_HISTORY_DATASET_ID = "ling/composer-history";
/** Current envelope version; a version bump needs a migration or old files must be rejected. */
const COMPOSER_HISTORY_VERSION = 1;
/**
 * Max entries read per parse. The history UI only shows a recent window; 10k covers years
 * of heavy use — more only stretches cold-start disk reads.
 */
const COMPOSER_HISTORY_PARSE_ENTRY_LIMIT = 10_000;
/**
 * Total file byte cap. A single legal message with full escaping costs ~6× UTF-16 code
 * units worst case; 8MiB holds that worst message + the longest cwd header + the
 * newest-first truncated window — beyond the cap, compaction drops the oldest.
 */
const COMPOSER_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

interface ComposerHistoryHeader {
	schema: typeof COMPOSER_HISTORY_DATASET_ID;
	version: typeof COMPOSER_HISTORY_VERSION;
	writtenAt: number;
}

/**
 * Max header-line bytes: measured by serializing once with the max writtenAt; read/write
 * split header/body at exactly this boundary instead of truncating a legal header at a
 * guessed fixed size.
 */
const COMPOSER_HISTORY_MAX_HEADER_BYTES = Buffer.byteLength(
	`${JSON.stringify({
		schema: COMPOSER_HISTORY_DATASET_ID,
		version: COMPOSER_HISTORY_VERSION,
		writtenAt: Number.MAX_SAFE_INTEGER,
	} satisfies ComposerHistoryHeader)}\n`,
	"utf8",
);

function assertComposerHistoryEntry(value: unknown, lineNumber: number): ComposerHistoryEntry {
	if (
		!isDatasetRecord(value) ||
		Object.keys(value).some((key) => key !== "text" && key !== "cwd" && key !== "createdAt") ||
		typeof value.text !== "string" ||
		value.text.length > SESSION_MESSAGE_TEXT_MAX_CHARS ||
		typeof value.cwd !== "string" ||
		value.cwd.length === 0 ||
		value.cwd.length > ABSOLUTE_PATH_MAX_CHARS ||
		value.cwd.includes("\0") ||
		!Number.isSafeInteger(value.createdAt) ||
		(value.createdAt as number) < 0
	) {
		throw datasetCorruption(COMPOSER_HISTORY_DATASET_ID, `Invalid composer history entry on line ${lineNumber}.`);
	}
	return {
		text: value.text,
		cwd: value.cwd,
		createdAt: value.createdAt as number,
	};
}

function assertHeader(value: unknown): void {
	inspectDatasetVersion(value, {
		datasetId: COMPOSER_HISTORY_DATASET_ID,
		schema: COMPOSER_HISTORY_DATASET_ID,
		currentVersion: COMPOSER_HISTORY_VERSION,
	});
	if (
		!isDatasetRecord(value) ||
		Object.keys(value).some((key) => key !== "schema" && key !== "version" && key !== "writtenAt") ||
		!Number.isSafeInteger(value.writtenAt) ||
		(value.writtenAt as number) < 0
	) {
		throw datasetCorruption(COMPOSER_HISTORY_DATASET_ID, "Composer history header is invalid.");
	}
}

function parseComposerHistoryJsonl(raw: string): ComposerHistoryEntry[] {
	const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
	if (lines.length === 0) return [];
	if (lines.length > COMPOSER_HISTORY_PARSE_ENTRY_LIMIT + 1) {
		throw datasetCorruption(
			COMPOSER_HISTORY_DATASET_ID,
			`Composer history exceeds ${COMPOSER_HISTORY_PARSE_ENTRY_LIMIT} entries.`,
		);
	}
	const firstLine = lines[0];
	if (firstLine === undefined) return [];
	const first = parseDatasetJson(firstLine, COMPOSER_HISTORY_DATASET_ID);
	assertHeader(first);
	const entries: ComposerHistoryEntry[] = [];
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) continue;
		const value = parseDatasetJson(line, COMPOSER_HISTORY_DATASET_ID);
		entries.push(assertComposerHistoryEntry(value, index + 1));
	}
	return entries;
}

function serializeComposerHistoryJsonl(entries: readonly ComposerHistoryEntry[], writtenAt = Date.now()): string {
	if (!Number.isSafeInteger(writtenAt) || writtenAt < 0) {
		throw datasetCorruption(COMPOSER_HISTORY_DATASET_ID, "Composer history writtenAt is invalid.");
	}
	const header: ComposerHistoryHeader = {
		schema: COMPOSER_HISTORY_DATASET_ID,
		version: COMPOSER_HISTORY_VERSION,
		writtenAt,
	};
	const values = [
		JSON.stringify(header),
		...entries.map((entry, index) => JSON.stringify(assertComposerHistoryEntry(entry, index + 2))),
	];
	const contents = `${values.join("\n")}\n`;
	if (Buffer.byteLength(contents, "utf8") > COMPOSER_HISTORY_MAX_BYTES) {
		throw datasetCorruption(
			COMPOSER_HISTORY_DATASET_ID,
			`Composer history exceeds ${COMPOSER_HISTORY_MAX_BYTES} bytes.`,
		);
	}
	return contents;
}

function composerHistoryEntryKey(entry: ComposerHistoryEntry): string {
	return `${entry.cwd}\0${entry.text}`;
}

function compactComposerHistoryEntries(entries: readonly ComposerHistoryEntry[]): ComposerHistoryEntry[] {
	const latestByCwdText = new Map<string, ComposerHistoryEntry>();
	for (const entry of entries) {
		if (entry.text.trim().length === 0) continue;
		const key = composerHistoryEntryKey(entry);
		latestByCwdText.delete(key);
		latestByCwdText.set(key, entry);
	}
	const candidates = [...latestByCwdText.values()].slice(-SESSION_COMPOSER_HISTORY_MAX_ITEMS);
	const selected: ComposerHistoryEntry[] = [];
	let remainingBytes = COMPOSER_HISTORY_MAX_BYTES - COMPOSER_HISTORY_MAX_HEADER_BYTES;
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const entry = candidates[index];
		if (!entry) continue;
		const entryBytes = Buffer.byteLength(`${JSON.stringify(assertComposerHistoryEntry(entry, index + 2))}\n`, "utf8");
		if (entryBytes > remainingBytes) break;
		selected.unshift(entry);
		remainingBytes -= entryBytes;
	}
	return selected;
}

function selectComposerHistoryEntries(
	entries: readonly ComposerHistoryEntry[],
	request: ListComposerHistoryRequest,
): ComposerHistoryEntry[] {
	const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
	const selected: ComposerHistoryEntry[] = [];
	const seenText = new Set<string>();
	const push = (entry: ComposerHistoryEntry) => {
		if (selected.length >= SESSION_COMPOSER_HISTORY_MAX_ITEMS || seenText.has(entry.text)) return;
		seenText.add(entry.text);
		selected.push(entry);
	};
	for (const entry of sorted) {
		if (entry.cwd === request.cwd) push(entry);
	}
	for (const entry of sorted) push(entry);
	return selected;
}

export function createComposerHistory({ userDataDir, database }: { userDataDir: string; database: HostDatabase }) {
	const historyPath = join(userDataDir, COMPOSER_HISTORY_FILE);
	let disposed = false;
	let disposal: Promise<void> | null = null;

	/** cwd string cap: same source as shared {@link ABSOLUTE_PATH_MAX_CHARS}. */
	let composerHistoryWriteQueue: Promise<void> = Promise.resolve();
	let pendingComposerHistoryEntries: ComposerHistoryEntry[] = [];
	let composerHistoryPersistFailed = false;
	/** In-memory cache of durable entries; invalidated on every successful write. */
	let durableComposerHistoryCache: ComposerHistoryEntry[] | null = null;
	function publish(entries: readonly ComposerHistoryEntry[]) {
		// The retained history keeps its existing count, text and encoded byte budgets.
		serializeComposerHistoryJsonl(entries);
		database.transaction(() => {
			database.run("DELETE FROM composer_history");
			for (const entry of entries)
				database.run(
					"INSERT INTO composer_history(cwd,text,created_at) VALUES(?,?,?)",
					entry.cwd,
					entry.text,
					entry.createdAt,
				);
		});
	}
	function ensureImported() {
		database.importLegacy({
			key: COMPOSER_HISTORY_DATASET_ID,
			source: historyPath,
			read() {
				const contents = readUtf8FileSyncBounded(historyPath, COMPOSER_HISTORY_MAX_BYTES);
				// A new installation has no history until its first submitted message.
				return contents === undefined ? [] : parseComposerHistoryJsonl(contents);
			},
			publish,
		});
	}

	function readComposerHistoryEntries(): ComposerHistoryEntry[] {
		if (durableComposerHistoryCache !== null) return durableComposerHistoryCache;
		ensureImported();
		const rows = database.all(
			"SELECT cwd,text,created_at AS createdAt FROM composer_history ORDER BY id LIMIT ?",
			COMPOSER_HISTORY_PARSE_ENTRY_LIMIT + 1,
		);
		if (rows.length > COMPOSER_HISTORY_PARSE_ENTRY_LIMIT)
			throw datasetCorruption(COMPOSER_HISTORY_DATASET_ID, "Composer history has too many entries.");
		const entries = rows.map((row, index) => assertComposerHistoryEntry(row, index + 2));
		serializeComposerHistoryJsonl(entries);
		durableComposerHistoryCache = entries;
		return entries;
	}

	async function persistPendingComposerHistoryEntries(): Promise<void> {
		if (pendingComposerHistoryEntries.length === 0) return;
		const entries = compactComposerHistoryEntries([...readComposerHistoryEntries(), ...pendingComposerHistoryEntries]);
		publish(entries);
		pendingComposerHistoryEntries = [];
		durableComposerHistoryCache = entries;
	}

	function enqueueComposerHistoryMutation(mutation: () => Promise<void>, trackFailure = true): Promise<void> {
		if (disposed) return Promise.reject(requestCancelled("Composer history is shutting down."));
		const run = composerHistoryWriteQueue
			.catch(() => undefined)
			.then(async () => {
				try {
					await mutation();
					composerHistoryPersistFailed = false;
				} catch (error) {
					if (trackFailure) composerHistoryPersistFailed = true;
					throw error;
				}
			});
		composerHistoryWriteQueue = run;
		return run;
	}

	function getComposerHistoryStatus(): ComposerHistoryStatus {
		const pendingEntries = pendingComposerHistoryEntries.length;
		return composerHistoryPersistFailed
			? { status: "degraded", errorCode: "COMPOSER_HISTORY_PERSIST_FAILED", pendingEntries }
			: { status: "ready", pendingEntries };
	}

	async function recordComposerHistoryEntry(cwd: string, text: string, createdAt: number = Date.now()): Promise<void> {
		if (text.trim().length === 0) return;
		await enqueueComposerHistoryMutation(async () => {
			pendingComposerHistoryEntries = compactComposerHistoryEntries([
				...pendingComposerHistoryEntries,
				{ text, cwd, createdAt },
			]);
			await persistPendingComposerHistoryEntries();
		});
	}

	async function flushComposerHistoryWrites(): Promise<void> {
		await enqueueComposerHistoryMutation(persistPendingComposerHistoryEntries);
	}

	function listComposerHistoryEntries(request: ListComposerHistoryRequest): ComposerHistoryEntry[] {
		return selectComposerHistoryEntries(
			compactComposerHistoryEntries([...readComposerHistoryEntries(), ...pendingComposerHistoryEntries]),
			request,
		);
	}

	async function clearComposerHistory(): Promise<void> {
		await enqueueComposerHistoryMutation(async () => {
			database.transaction(() => {
				publish([]);
				database.markImported(COMPOSER_HISTORY_DATASET_ID, historyPath);
			});
			pendingComposerHistoryEntries = [];
			durableComposerHistoryCache = [];
		}, false);
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		const flushed = enqueueComposerHistoryMutation(persistPendingComposerHistoryEntries);
		disposed = true;
		disposal = flushed.then(() => {
			durableComposerHistoryCache = null;
		});
		return disposal;
	}
	return {
		inspect() {
			readComposerHistoryEntries();
			return getComposerHistoryStatus();
		},
		getComposerHistoryStatus,
		recordComposerHistoryEntry,
		flushComposerHistoryWrites,
		listComposerHistoryEntries,
		clearComposerHistory,
		dispose,
	};
}

export type ComposerHistory = ReturnType<typeof createComposerHistory>;
