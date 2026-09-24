import { errorCode } from "@ling/contracts/ling-error";
import { createAtomicTextFileWriter, fsyncDirectory, resolveMutationTarget } from "@ling/node-runtime/atomic-file";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { type FileHandle, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { throwAggregateFailures, throwIfOperationAborted, waitForOperation } from "../ling-error";

/** Chunk size for bounded reads; 64KiB avoids loading a large file into memory at once while keeping throughput. */
const READ_CHUNK_BYTES = 64 * 1024;
/**
 * Default proper-lockfile cooperative lock options. realpath:false matches Pi locking
 * the configured path as-is; short retries over ~1s cover CLI concurrent-write spikes,
 * anything longer would stall UI transactions.
 */
const FILE_LOCK_OPTIONS = {
	realpath: false,
	retries: {
		factor: 1,
		maxTimeout: 50,
		minTimeout: 25,
		retries: 40,
	},
} as const;
type FileLockOptions = NonNullable<Parameters<typeof lockfile.lock>[1]>;
type StoreFileLockOptions = Omit<FileLockOptions, "onCompromised" | "realpath">;

function assertByteLimit(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`Invalid file size limit: ${maxBytes}`);
}

/** Lets derived-cache owners distinguish an ineligible size from a failed read or corrupt encoding. */
export class FileSizeLimitError extends Error {
	constructor(filePath: string, maxBytes: number) {
		super(`File exceeds ${maxBytes} bytes: ${filePath}`);
		this.name = "FileSizeLimitError";
	}
}

/**
 * Reads one stable file handle, accepting at most `maxBytes` (plus one probe byte to
 * detect concurrent growth). `undefined` is reserved for a missing file; every other
 * filesystem/encoding error is surfaced to the caller.
 */
export async function readUtf8FileBounded(
	filePath: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return readUtf8FileBoundedWithBomPolicy(filePath, maxBytes, signal, false);
}

/** Adapters whose upstream format rejects BOMs must observe the original text before parsing. */
export async function readUtf8FileBoundedPreserveBom(
	filePath: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return readUtf8FileBoundedWithBomPolicy(filePath, maxBytes, signal, true);
}

async function readUtf8FileBoundedWithBomPolicy(
	filePath: string,
	maxBytes: number,
	signal: AbortSignal | undefined,
	preserveBom: boolean,
): Promise<string | undefined> {
	assertByteLimit(maxBytes);
	throwIfOperationAborted(signal);
	let handle: FileHandle;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}

	try {
		throwIfOperationAborted(signal);
		const info = await handle.stat();
		throwIfOperationAborted(signal);
		if (!info.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
		if (info.size > maxBytes) throw new FileSizeLimitError(filePath, maxBytes);

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (true) {
			throwIfOperationAborted(signal);
			// Read one byte past the ceiling so growth after stat() cannot bypass the bound.
			const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes + 1));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes);
			throwIfOperationAborted(signal);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			if (totalBytes > maxBytes) throw new FileSizeLimitError(filePath, maxBytes);
			chunks.push(buffer.subarray(0, bytesRead));
		}

		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom }).decode(
				Buffer.concat(chunks, totalBytes),
			);
		} catch (error) {
			throw new Error(`File is not valid UTF-8: ${filePath}`, { cause: error });
		}
	} finally {
		await handle.close();
	}
}

/** Startup-owned metadata sometimes has a synchronous API because the native shell reads it while
 * deciding window behavior. This mirrors the async reader's byte/UTF-8 guarantees instead of
 * letting each synchronous caller reinvent an unbounded `readFileSync`. */
export function readUtf8FileSyncBounded(filePath: string, maxBytes: number): string | undefined {
	return readUtf8FileSyncBoundedWithBomPolicy(filePath, maxBytes, false);
}

/** Same bounded synchronous read while retaining a leading UTF-8 BOM in the returned source.
 * Use only when exact source identity matters, such as compare-and-restore transactions. */
export function readUtf8FileSyncBoundedPreserveBom(filePath: string, maxBytes: number): string | undefined {
	return readUtf8FileSyncBoundedWithBomPolicy(filePath, maxBytes, true);
}

function readUtf8FileSyncBoundedWithBomPolicy(
	filePath: string,
	maxBytes: number,
	preserveBom: boolean,
): string | undefined {
	assertByteLimit(maxBytes);
	let fileDescriptor: number;
	try {
		fileDescriptor = openSync(filePath, "r");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}

	try {
		const info = fstatSync(fileDescriptor);
		if (!info.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
		if (info.size > maxBytes) throw new FileSizeLimitError(filePath, maxBytes);
		const bytes = Buffer.allocUnsafe(maxBytes + 1);
		let totalBytes = 0;
		while (totalBytes <= maxBytes) {
			const bytesRead = readSync(fileDescriptor, bytes, totalBytes, maxBytes + 1 - totalBytes, totalBytes);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
		}
		if (totalBytes > maxBytes) throw new FileSizeLimitError(filePath, maxBytes);
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom }).decode(bytes.subarray(0, totalBytes));
		} catch (error) {
			throw new Error(`File is not valid UTF-8: ${filePath}`, { cause: error });
		}
	} finally {
		closeSync(fileDescriptor);
	}
}

function reportNonFatal(context: string, error: unknown): void {
	// Not a logger dependency: this module is imported by early-startup code paths.
	console.error(`[atomic-file-store] ${context}:`, error);
}

/** Sibling that holds the previous good version of an atomically written file. */
export function backupFilePath(filePath: string): string {
	return `${filePath}.bak`;
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

const atomicWriterOptions = {
	onWarning: reportNonFatal,
};
export const writeTextFileAtomic = createAtomicTextFileWriter(atomicWriterOptions);

const mutationQueues = new Map<string, Promise<void>>();

// Deliberately not using the SDK's withFileMutationQueue: it keys the queue by realpath,
// while this module must support locking the configured path instead of the realpath when
// coordinating with Pi's SettingsManager.
function enqueueMutation<Result>(
	filePath: string,
	operation: () => Promise<Result>,
	signal?: AbortSignal,
): Promise<Result> {
	throwIfOperationAborted(signal);
	const previous = mutationQueues.get(filePath) ?? Promise.resolve();
	const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
	const running = previous.then(() => {
		throwIfOperationAborted(signal);
		markStarted();
		return operation();
	});
	const tail = running.then(
		() => undefined,
		() => undefined,
	);
	mutationQueues.set(filePath, tail);
	void tail.then(() => {
		if (mutationQueues.get(filePath) === tail) mutationQueues.delete(filePath);
	});
	// Stop waiting promptly while the operation is still queued. Once it owns the
	// transaction, however, return its real settlement: an abort that races the final
	// atomic publication must not report "cancelled before commit" after data was saved.
	return waitForOperation(started, signal).then(() => running);
}

interface AtomicFileOperationOptions {
	signal?: AbortSignal;
}

interface AtomicFileStoreOptions<Value> {
	getPath: () => string;
	/** Lock the resolved target for shared stores, or the configured path when an external
	 * writer (such as Pi's SettingsManager) coordinates on that exact pathname. */
	lockPath: "configured" | "target";
	/** Optional store-specific cooperative lock policy. `realpath` is always false
	 * because `lockPath` resolution above already chooses the canonical target. */
	lockOptions?: StoreFileLockOptions;
	/** Acquire the same cooperative lock for reads. Use for files whose external
	 * writers publish in place while holding this lock (Pi's auth.json); atomic
	 * rename stores already provide stable lock-free snapshots. */
	lockReads?: boolean;
	maxBytes: number;
	create: () => Value;
	parse: (source: string, filePath: string) => Value;
	serialize: (value: Value) => string;
}

interface AtomicFileStore<Value> {
	read(options?: AtomicFileOperationOptions): Promise<Value>;
	update<Result>(
		mutate: (value: Value) => Result | Promise<Result>,
		options?: AtomicFileOperationOptions,
	): Promise<Result>;
	/** Read-modify-write transaction whose owner can explicitly leave the source untouched.
	 * This matters for callback contracts where "no change" must not refresh mtimes, replace
	 * symlink targets, or race file watchers with a semantically identical publication. */
	transact<Result>(
		mutate: (
			value: Value,
			context: AtomicFileTransactionContext,
		) => AtomicFileTransactionResult<Result> | Promise<AtomicFileTransactionResult<Result>>,
		options?: AtomicFileOperationOptions,
	): Promise<Result>;
}

interface AtomicFileTransactionContext {
	/** Exact valid UTF-8 text read under the transaction lock, or undefined when the file did not exist. */
	source: string | undefined;
	/** Resolved file that will receive the atomic publication. */
	targetPath: string;
}

type AtomicFileTransactionResult<Result> =
	| {
			commit: true;
			result: Result;
			/** Recovery-only override for restoring an earlier source exactly. The caller
			 * supplies text already parsed by this store, or null when that source was absent. */
			serializedContents?: string | null;
	  }
	| { commit: false; result: Result };

/**
 * Creates a bounded snapshot reader plus a serialized read-modify-write transaction.
 * The process queue preserves call order; the cooperative filesystem lock prevents
 * separate Ling processes from reading the same stale state before publishing.
 */
export function createAtomicFileStore<Value>(options: AtomicFileStoreOptions<Value>): AtomicFileStore<Value> {
	const fileLockOptions: StoreFileLockOptions = { ...FILE_LOCK_OPTIONS, ...options.lockOptions };

	async function withLock<Result>(
		lockPath: string,
		operation: (assertHealthy: () => void) => Promise<Result>,
		signal?: AbortSignal,
	): Promise<Result> {
		const lockState: { compromised: Error | null } = { compromised: null };
		throwIfOperationAborted(signal);
		const acquisition = lockfile.lock(lockPath, {
			...fileLockOptions,
			realpath: false,
			// proper-lockfile's default callback throws from its background refresh
			// timer. Capture the failure so the owning transaction rejects instead of
			// surfacing an uncaught process-level exception.
			onCompromised: (error) => {
				lockState.compromised = error;
			},
		});
		let release: Awaited<typeof acquisition>;
		try {
			release = await waitForOperation(acquisition, signal);
		} catch (error) {
			// proper-lockfile cannot cancel its retry loop. If it eventually acquires the
			// lock after the owner has cancelled, release it immediately and never enter
			// the file operation. Observing both branches also prevents late rejections.
			void acquisition.then(
				async (releaseLate) => {
					try {
						await releaseLate();
					} catch (releaseError) {
						reportNonFatal(`could not release cancelled lock acquisition for ${lockPath}`, releaseError);
					}
				},
				() => undefined,
			);
			throw error;
		}
		const assertHealthy = () => {
			if (lockState.compromised) throw lockState.compromised;
		};
		let outcome: { ok: true; value: Result } | { ok: false; error: unknown };
		try {
			throwIfOperationAborted(signal);
			assertHealthy();
			outcome = { ok: true, value: await operation(assertHealthy) };
			assertHealthy();
		} catch (error) {
			outcome = { ok: false, error };
		}
		const failures: unknown[] = outcome.ok ? [] : [outcome.error];
		const appendCompromise = () => {
			if (lockState.compromised && !failures.includes(lockState.compromised)) {
				failures.push(lockState.compromised);
			}
		};
		appendCompromise();
		try {
			await release();
		} catch (releaseError) {
			// A compromised lock is already marked released by proper-lockfile. Keep
			// that primary failure instead of adding the expected ERELEASED cleanup error.
			// Every unrelated release failure remains useful evidence alongside an
			// operation failure and must not silently disappear.
			appendCompromise();
			if (!(lockState.compromised && errorCode(releaseError) === "ERELEASED")) failures.push(releaseError);
		}
		appendCompromise();
		throwAggregateFailures(failures, `Atomic file operation or lock release failed: ${lockPath}`);
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}

	async function readSnapshotAt(
		filePath: string,
		signal?: AbortSignal,
	): Promise<{ source: string | undefined; value: Value }> {
		throwIfOperationAborted(signal);
		// Preserve a leading BOM in the recovery source, but keep the parse contract
		// unchanged: callers historically receive decoded JSON text without it.
		const source = await readUtf8FileBoundedWithBomPolicy(filePath, options.maxBytes, signal, true);
		const parseSource = source?.startsWith("\uFEFF") ? source.slice(1) : source;
		throwIfOperationAborted(signal);
		return {
			source,
			value: parseSource === undefined ? options.create() : options.parse(parseSource, filePath),
		};
	}

	async function readAt(filePath: string, signal?: AbortSignal): Promise<Value> {
		return (await readSnapshotAt(filePath, signal)).value;
	}

	async function readLocked(configuredPath: string, signal?: AbortSignal): Promise<Value> {
		throwIfOperationAborted(signal);
		const lockPath = options.lockPath === "configured" ? configuredPath : await resolveMutationTarget(configuredPath);
		throwIfOperationAborted(signal);
		await mkdir(dirname(lockPath), { recursive: true });
		throwIfOperationAborted(signal);
		return withLock(
			lockPath,
			async (assertHealthy) => {
				const targetPath = options.lockPath === "configured" ? await resolveMutationTarget(configuredPath) : lockPath;
				const value = await readAt(targetPath, signal);
				assertHealthy();
				return value;
			},
			signal,
		);
	}

	function transact<Result>(
		mutate: (
			value: Value,
			context: AtomicFileTransactionContext,
		) => AtomicFileTransactionResult<Result> | Promise<AtomicFileTransactionResult<Result>>,
		operationOptions: AtomicFileOperationOptions = {},
	): Promise<Result> {
		const { signal } = operationOptions;
		throwIfOperationAborted(signal);
		const configuredPath = options.getPath();
		return enqueueMutation(
			configuredPath,
			async () => {
				throwIfOperationAborted(signal);
				const lockPath =
					options.lockPath === "configured" ? configuredPath : await resolveMutationTarget(configuredPath);
				throwIfOperationAborted(signal);
				await mkdir(dirname(lockPath), { recursive: true });
				throwIfOperationAborted(signal);
				return withLock(
					lockPath,
					async (assertHealthy) => {
						const targetPath =
							options.lockPath === "configured" ? await resolveMutationTarget(configuredPath) : lockPath;
						const snapshot = await readSnapshotAt(targetPath, signal);
						const value = snapshot.value;
						throwIfOperationAborted(signal);
						const transaction = await mutate(value, { source: snapshot.source, targetPath });
						throwIfOperationAborted(signal);
						assertHealthy();
						if (!transaction.commit) return transaction.result;
						if (transaction.serializedContents === null) {
							await unlinkIfExists(targetPath);
							try {
								await fsyncDirectory(dirname(targetPath));
							} catch (fsyncError) {
								reportNonFatal(`could not fsync directory for ${targetPath}`, fsyncError);
							}
							assertHealthy();
							return transaction.result;
						}
						const contents = transaction.serializedContents ?? options.serialize(value);
						if (Buffer.byteLength(contents, "utf8") > options.maxBytes) {
							throw new Error(`Serialized file exceeds ${options.maxBytes} bytes: ${targetPath}`);
						}
						throwIfOperationAborted(signal);
						await writeTextFileAtomic(targetPath, contents);
						assertHealthy();
						return transaction.result;
					},
					signal,
				);
			},
			signal,
		);
	}

	return {
		read: (operationOptions = {}) => {
			const { signal } = operationOptions;
			throwIfOperationAborted(signal);
			const configuredPath = options.getPath();
			return options.lockReads
				? enqueueMutation(configuredPath, () => readLocked(configuredPath, signal), signal)
				: waitForOperation(readAt(configuredPath, signal), signal);
		},
		update: <Result>(
			mutate: (value: Value) => Result | Promise<Result>,
			operationOptions: AtomicFileOperationOptions = {},
		): Promise<Result> => {
			return transact(async (value) => ({ commit: true, result: await mutate(value) }), operationOptions);
		},
		transact,
	};
}
