import { requestCancelled } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { createReadStream, type Dirent } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { parsePiSessionEntryTimestamp } from "@ling/core/transcript/session-entry-identity";

const log = createLogger("usage-scan");

/**
 * Session-file scanning and parse caching for usage stats: walks Pi's sessions dir
 * (~/.pi/agent/sessions/<encoded-cwd>/*.jsonl), parses each line into UsageRecord,
 * and caches per-file results keyed by a fingerprint (size/inode/mtime/ctime).
 */

interface RawUsage {
	totalTokens?: unknown;
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: unknown;
}

export interface UsageBreakdown {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
}

interface RawMessage {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	responseModel?: unknown;
	usage?: unknown;
	timestamp?: unknown;
}

interface RawEntry {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	message?: unknown;
	usage?: unknown;
	provider?: unknown;
	model?: unknown;
}

export type UsageRecord =
	| { role: "user"; timestampMs: number; dedupeKey: string }
	| {
			role: "usage";
			source: "assistant" | "other";
			timestampMs: number;
			dedupeKey: string;
			usage: UsageBreakdown | null;
			provider: string | null;
			model: string | null;
	  };

function messageTimestampMs(entry: RawEntry, message: RawMessage): number | null {
	if (typeof message.timestamp === "number" && Number.isSafeInteger(message.timestamp) && message.timestamp >= 0) {
		return message.timestamp;
	}
	return parsePiSessionEntryTimestamp(entry.timestamp);
}

function tokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseUsage(value: unknown): UsageBreakdown | null {
	if (typeof value !== "object" || value === null) return null;
	const usage = value as RawUsage;
	const totalTokens = tokenCount(usage.totalTokens);
	if (totalTokens === null) return null;
	const rawCost = usage.cost as { total?: unknown } | null | undefined;
	const cost =
		typeof rawCost === "object" &&
		rawCost !== null &&
		typeof rawCost.total === "number" &&
		Number.isFinite(rawCost.total) &&
		rawCost.total >= 0
			? rawCost.total
			: 0;
	const inputTokens = tokenCount(usage.input) ?? 0;
	const outputTokens = tokenCount(usage.output) ?? 0;
	const cacheReadTokens = tokenCount(usage.cacheRead) ?? 0;
	const cacheWriteTokens = tokenCount(usage.cacheWrite) ?? 0;
	return {
		totalTokens: Math.max(totalTokens, inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		cost,
	};
}

export function parseUsageRecord(line: string, fileId: string, lineNo: number): UsageRecord | null {
	if (!line.trim()) return null;
	let entry: RawEntry;
	try {
		entry = JSON.parse(line) as RawEntry;
	} catch (cause) {
		throw new Error("Invalid Pi session JSONL entry", { cause });
	}
	if (entry.type === "message" && typeof entry.message === "object" && entry.message !== null) {
		const message = entry.message as RawMessage;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return null;
		const timestampMs = messageTimestampMs(entry, message);
		if (timestampMs === null) return null;
		const dedupeKey = typeof entry.id === "string" ? `${entry.id}:${timestampMs}` : `${fileId}:${lineNo}`;
		if (message.role === "user") return { role: "user", timestampMs, dedupeKey };
		const responseModel = typeof message.responseModel === "string" ? message.responseModel : null;
		return {
			role: "usage",
			source: message.role === "assistant" ? "assistant" : "other",
			timestampMs,
			dedupeKey,
			usage: parseUsage(message.usage),
			provider: message.role === "assistant" && typeof message.provider === "string" ? message.provider : null,
			model:
				message.role === "assistant" && responseModel !== null
					? responseModel
					: message.role === "assistant" && typeof message.model === "string"
						? message.model
						: null,
		};
	}
	if (entry.type !== "compaction" && entry.type !== "branch_summary" && entry.type !== "usage") return null;
	const timestampMs = parsePiSessionEntryTimestamp(entry.timestamp);
	if (timestampMs === null) return null;
	return {
		role: "usage",
		source: "other",
		timestampMs,
		dedupeKey: typeof entry.id === "string" ? `${entry.id}:${timestampMs}` : `${fileId}:${lineNo}`,
		usage: parseUsage(entry.usage),
		provider: typeof entry.provider === "string" ? entry.provider : null,
		model: typeof entry.model === "string" ? entry.model : null,
	};
}

interface CollectedUsageFiles {
	files: string[];
	directoryCount: number;
	pathChars: number;
	truncated: boolean;
}

/** Bound the path inventory before any per-file arrays/cache entries are created. */
const MAX_USAGE_SCAN_FILES = 50_000;
/** Empty directory trees must be bounded independently from the number of JSONL files. */
const MAX_USAGE_SCAN_DIRECTORIES = 50_000;
/** Visited directory and retained file paths share an aggregate character budget (roughly 16 MiB UTF-16). */
const MAX_USAGE_SCAN_PATH_CHARS = 8 * 1024 * 1024;

async function collectJsonlFiles(
	dir: string,
	signal: AbortSignal,
	collection: CollectedUsageFiles = { files: [], directoryCount: 0, pathChars: 0, truncated: false },
): Promise<CollectedUsageFiles> {
	signal.throwIfAborted();
	if (collection.truncated) return collection;
	if (collection.pathChars + dir.length > MAX_USAGE_SCAN_PATH_CHARS) {
		collection.truncated = true;
		return collection;
	}
	collection.pathChars += dir.length;
	const pendingDirectories = [dir];
	while (pendingDirectories.length > 0 && !collection.truncated) {
		signal.throwIfAborted();
		if (collection.directoryCount >= MAX_USAGE_SCAN_DIRECTORIES) {
			collection.truncated = true;
			break;
		}
		const currentDirectory = pendingDirectories.pop();
		if (currentDirectory === undefined) break;
		collection.directoryCount += 1;
		let directory: Awaited<ReturnType<typeof opendir>>;
		try {
			directory = await opendir(currentDirectory);
		} catch (error) {
			// A missing sessions dir is a fresh install; a vanished child was removed mid-scan.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		// Finish one directory before opening another so depth cannot accumulate descriptors.
		for await (const entry of directory as AsyncIterable<Dirent>) {
			signal.throwIfAborted();
			if (collection.files.length >= MAX_USAGE_SCAN_FILES) {
				collection.truncated = true;
				break;
			}
			const full = join(currentDirectory, entry.name);
			if (entry.isDirectory()) {
				if (
					collection.directoryCount + pendingDirectories.length >= MAX_USAGE_SCAN_DIRECTORIES ||
					collection.pathChars + full.length > MAX_USAGE_SCAN_PATH_CHARS
				) {
					collection.truncated = true;
					break;
				}
				collection.pathChars += full.length;
				pendingDirectories.push(full);
			} else if (entry.isFile() && extname(entry.name) === ".jsonl") {
				if (collection.pathChars + full.length > MAX_USAGE_SCAN_PATH_CHARS) {
					collection.truncated = true;
					break;
				}
				collection.files.push(full);
				collection.pathChars += full.length;
			}
		}
	}
	return collection;
}

interface CachedUsageFile {
	sessionsDir: string;
	fingerprint: string;
	cutoffMs: number;
	records: UsageRecord[];
	weightBytes: number;
}

interface UsageFileRecords {
	filePath: string;
	records: UsageRecord[];
	weightBytes: number;
}

interface UsageFileScanResult {
	files: UsageFileRecords[];
	skippedFileCount: number;
}

/**
 * Three-axis limits of the usage parse cache (file count / record count / estimated bytes). A long-lived process
 * cannot retain every scanned session JSONL; bytes are a conservative estimated weight, not real heap.
 */
/** Max number of session files whose parse results are cached per scanner. */
const MAX_CACHED_USAGE_FILES = 2_048;
/** Max number of usage records cached per scanner. */
const MAX_CACHED_USAGE_RECORDS = 200_000;
/** Per-scanner cache weight byte limit (64MiB). */
const MAX_CACHED_USAGE_WEIGHT_BYTES = 64 * 1024 * 1024;
/** Max cached records per file, keeping oversized JSONL from monopolizing the cache. */
const MAX_CACHED_USAGE_FILE_RECORDS = 25_000;
/** Per-file cache weight limit (8MiB). */
const MAX_CACHED_USAGE_FILE_WEIGHT_BYTES = 8 * 1024 * 1024;
/** A shared scan result is retained until every concurrent range projection settles. */
const MAX_USAGE_SCAN_RECORDS = 200_000;
const MAX_USAGE_SCAN_WEIGHT_BYTES = 64 * 1024 * 1024;
/**
 * Fixed base weight per record. Each record also carries a few strings; 96 is on the order of the measured
 * object overhead and is used for weight estimation, not precise heap accounting.
 */
const USAGE_RECORD_BASE_WEIGHT_BYTES = 96;

async function fileFingerprint(filePath: string): Promise<string> {
	const metadata = await stat(filePath, { bigint: true });
	// size catches appends, inode catches atomic replacement on POSIX, and ctime catches
	// same-size rewrites whose mtime was restored. All fields are available on bigint
	// Stats on the supported Node runtime; dev/ino may be zero on some Windows volumes,
	// so correctness must not rely on either field alone.
	return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function usageRecordWeight(record: UsageRecord): number {
	let weight = USAGE_RECORD_BASE_WEIGHT_BYTES + record.dedupeKey.length * 2;
	if (record.role === "usage") {
		if (record.provider !== null) weight += record.provider.length * 2;
		if (record.model !== null) weight += record.model.length * 2;
	}
	return weight;
}

function cachedRecordsWeight(records: UsageRecord[]): number {
	let weight = 0;
	for (const record of records) {
		weight += usageRecordWeight(record);
		if (weight > MAX_CACHED_USAGE_FILE_WEIGHT_BYTES) return weight;
	}
	return weight;
}

export interface UsageScanner {
	scanFiles(sessionsDir: string, cutoffMs: number): Promise<UsageFileScanResult>;
	/** Stops admission, cancels reads and waits for file descriptors before releasing cached records. */
	dispose(): Promise<void>;
}

/** One usage worker owns one scanner; independent owners never share cached data or pending reads. */
export function createUsageScanner(): UsageScanner {
	const controller = new AbortController();
	const { signal } = controller;
	const usageFileCache = new Map<string, CachedUsageFile>();
	const usageScansInFlight = new Map<string, Promise<UsageFileScanResult>>();
	const usageFileScans = new Map<string, symbol>();
	let cachedUsageRecords = 0;
	let cachedUsageWeightBytes = 0;
	let disposal: Promise<void> | null = null;

	function deleteCachedUsageFile(filePath: string, expected?: CachedUsageFile): void {
		const cached = usageFileCache.get(filePath);
		if (!cached || (expected && cached !== expected)) return;
		usageFileCache.delete(filePath);
		cachedUsageRecords -= cached.records.length;
		cachedUsageWeightBytes -= cached.weightBytes;
	}

	function setCachedUsageFile(filePath: string, cached: Omit<CachedUsageFile, "weightBytes">): void {
		const weightBytes = cachedRecordsWeight(cached.records);
		deleteCachedUsageFile(filePath);
		// Every refresh traverses every file, so evicting a live entry to admit the next one
		// would make directories over the limit miss 100% of the cache on every pass. Keep a
		// stable bounded subset instead; deletion, directory changes, and rewrites free slots.
		if (
			cached.records.length > MAX_CACHED_USAGE_FILE_RECORDS ||
			weightBytes > MAX_CACHED_USAGE_FILE_WEIGHT_BYTES ||
			usageFileCache.size >= MAX_CACHED_USAGE_FILES ||
			cachedUsageRecords + cached.records.length > MAX_CACHED_USAGE_RECORDS ||
			cachedUsageWeightBytes + weightBytes > MAX_CACHED_USAGE_WEIGHT_BYTES
		) {
			return;
		}

		usageFileCache.set(filePath, { ...cached, weightBytes });
		cachedUsageRecords += cached.records.length;
		cachedUsageWeightBytes += weightBytes;
	}

	async function scanFileRecords(
		filePath: string,
		cutoffMs: number,
	): Promise<{ records: UsageRecord[]; weightBytes: number }> {
		const records: UsageRecord[] = [];
		let recordsWeight = 0;
		const input = createReadStream(filePath);
		const rl = createInterface({ input, crlfDelay: Infinity });
		let inputError: Error | undefined;
		const closed = new Promise<void>((resolve) => input.once("close", resolve));
		const stopReading = () => {
			rl.close();
			input.destroy();
		};
		const onInputError = (error: Error) => {
			inputError = error;
			rl.close();
		};
		input.on("error", onInputError);
		signal.addEventListener("abort", stopReading, { once: true });
		let lineNo = 0;
		try {
			signal.throwIfAborted();
			for await (const line of rl) {
				signal.throwIfAborted();
				lineNo += 1;
				const record = parseUsageRecord(line, filePath, lineNo);
				if (record && record.timestampMs >= cutoffMs) {
					const nextWeight = usageRecordWeight(record);
					if (
						records.length >= MAX_CACHED_USAGE_FILE_RECORDS ||
						recordsWeight + nextWeight > MAX_CACHED_USAGE_FILE_WEIGHT_BYTES
					) {
						throw new Error("Session usage records exceed the bounded per-file scan limit");
					}
					records.push(record);
					recordsWeight += nextWeight;
				}
			}
			signal.throwIfAborted();
			if (inputError !== undefined) throw inputError;
		} finally {
			signal.removeEventListener("abort", stopReading);
			// readline.close() pauses input; destruction and the close event release the fd
			// before the scanner's disposal promise can settle.
			stopReading();
			await closed;
			input.off("error", onInputError);
		}
		return { records, weightBytes: recordsWeight };
	}

	async function loadFileRecords(filePath: string, sessionsDir: string, cutoffMs: number): Promise<UsageFileRecords> {
		signal.throwIfAborted();
		const fingerprintBefore = await fileFingerprint(filePath);
		signal.throwIfAborted();
		const cached = usageFileCache.get(filePath);
		if (
			cached?.sessionsDir === sessionsDir &&
			cached.fingerprint === fingerprintBefore &&
			cached.cutoffMs <= cutoffMs
		) {
			const records =
				cached.cutoffMs === cutoffMs
					? cached.records
					: cached.records.filter((record) => record.timestampMs >= cutoffMs);
			if (cached.cutoffMs !== cutoffMs) {
				setCachedUsageFile(filePath, { ...cached, cutoffMs, records });
			}
			return { filePath, records, weightBytes: cachedRecordsWeight(records) };
		}

		const scanToken = Symbol(filePath);
		usageFileScans.set(filePath, scanToken);
		try {
			const { records, weightBytes } = await scanFileRecords(filePath, cutoffMs);
			const fingerprintAfter = await fileFingerprint(filePath);
			signal.throwIfAborted();
			if (usageFileScans.get(filePath) === scanToken) {
				if (fingerprintAfter === fingerprintBefore) {
					setCachedUsageFile(filePath, { sessionsDir, fingerprint: fingerprintAfter, cutoffMs, records });
				} else {
					// The writer changed the file while the stream was open. Use the safe partial
					// result for this request, but invalidate only the cache version this scan saw;
					// a newer concurrent scan may already have installed a complete version.
					deleteCachedUsageFile(filePath, cached);
				}
			}
			return { filePath, records, weightBytes };
		} catch (error) {
			// A permanently unreadable or over-limit file must not pin its previous parse
			// forever. Do not delete a newer concurrent scan's successfully installed entry.
			if (usageFileScans.get(filePath) === scanToken) deleteCachedUsageFile(filePath, cached);
			throw error;
		} finally {
			if (usageFileScans.get(filePath) === scanToken) usageFileScans.delete(filePath);
		}
	}

	async function loadUsageFileRecords(sessionsDir: string, cutoffMs: number): Promise<UsageFileScanResult> {
		const collection = await collectJsonlFiles(sessionsDir, signal);
		signal.throwIfAborted();
		const files = collection.files;
		const liveFiles = new Set(files);
		for (const [filePath, cached] of usageFileCache) {
			if (cached.sessionsDir !== sessionsDir || !liveFiles.has(filePath)) deleteCachedUsageFile(filePath, cached);
		}

		const loaded: UsageFileRecords[] = [];
		let skippedFileCount = collection.truncated ? 1 : 0;
		let loadedRecordCount = 0;
		let loadedWeightBytes = 0;
		for (const [index, filePath] of files.entries()) {
			try {
				const file = await loadFileRecords(filePath, sessionsDir, cutoffMs);
				if (
					loadedRecordCount + file.records.length > MAX_USAGE_SCAN_RECORDS ||
					loadedWeightBytes + file.weightBytes > MAX_USAGE_SCAN_WEIGHT_BYTES
				) {
					// Stop once the aggregate result reaches its budget. Continuing to parse and
					// immediately discard thousands of files would only create transient pressure.
					skippedFileCount += files.length - index;
					break;
				}
				loaded.push(file);
				loadedRecordCount += file.records.length;
				loadedWeightBytes += file.weightBytes;
			} catch (error) {
				// Owner cancellation is a failed operation, never a partial empty result.
				signal.throwIfAborted();
				// Keep the page usable, but return an explicit bounded incompleteness fact.
				skippedFileCount += 1;
				log.warn(`skipping unreadable session file ${filePath}:`, error);
			}
		}
		return { files: loaded, skippedFileCount };
	}

	function scanFiles(sessionsDir: string, cutoffMs: number): Promise<UsageFileScanResult> {
		if (signal.aborted) return Promise.reject(signal.reason);
		const key = `${sessionsDir}\0${cutoffMs}`;
		const existing = usageScansInFlight.get(key);
		if (existing) return existing;
		const scan = loadUsageFileRecords(sessionsDir, cutoffMs).finally(() => {
			if (usageScansInFlight.get(key) === scan) usageScansInFlight.delete(key);
		});
		usageScansInFlight.set(key, scan);
		return scan;
	}

	function dispose(): Promise<void> {
		if (disposal !== null) return disposal;
		controller.abort(requestCancelled("Usage scanner is closed."));
		// Scan failures already belong to their callers; shutdown observes their settlement
		// so expected cancellation cannot leave an unhandled rejection or retained stream.
		disposal = Promise.allSettled([...usageScansInFlight.values()]).then(() => {
			usageScansInFlight.clear();
			usageFileScans.clear();
			usageFileCache.clear();
			cachedUsageRecords = 0;
			cachedUsageWeightBytes = 0;
		});
		return disposal;
	}

	return { scanFiles, dispose };
}
