import { lstatSync, realpathSync } from "node:fs";
import { chmod, chown, copyFile, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import writeFileAtomic from "write-file-atomic";

// v7 awaits this hook; the separately published v4 declarations still describe it as void.
const publishAtomic: (
	path: string,
	contents: string,
	options: Omit<writeFileAtomic.Options, "tmpfileCreated"> & {
		tmpfileCreated(path: string): Promise<void>;
	},
) => Promise<void> = writeFileAtomic;

/** Four Windows retries cover brief indexer locks within 250 ms. */
const WINDOWS_RETRY_LIMIT = 4;
const WINDOWS_RETRY_STEP_MS = 25;

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** Follows existing dotfile symlinks while rejecting dangling links and lookup failures. */
export async function resolveMutationTarget(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	try {
		if ((await lstat(filePath)).isSymbolicLink()) throw new Error(`File symlink target does not exist: ${filePath}`);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	return filePath;
}

export function resolveMutationTargetSync(filePath: string): string {
	try {
		return realpathSync(filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	try {
		if (lstatSync(filePath).isSymbolicLink()) throw new Error(`File symlink target does not exist: ${filePath}`);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	return filePath;
}

/** Windows cannot open a directory for fsync; POSIX publications flush its rename entry. */
export async function fsyncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

interface AtomicTextFileWriterOptions {
	onWarning(context: string, error: unknown): void;
	/** Undefined preserves existing permissions, or creates a private 0600 file. */
	mode?: number;
	keepBackup?: boolean;
}

/** Publications to one path run serially; a write queued behind an active one carries the latest contents. */
export function createAtomicTextFileWriter(options: AtomicTextFileWriterOptions) {
	const active = new Map<string, Promise<void>>();
	const queued = new Map<
		string,
		{ contents: string; publication: Promise<void>; resolve(): void; reject(error: unknown): void }
	>();
	async function publish(filePath: string, contents: string): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		const target = await resolveMutationTarget(filePath);
		let metadata: { mode: number; uid: number; gid: number } | undefined;
		try {
			const info = await stat(target);
			if (!info.isFile()) throw new Error(`Expected a regular file: ${target}`);
			metadata = { mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const mode = options.mode ?? metadata?.mode ?? 0o600;
		if (options.keepBackup && metadata) {
			// The primary remains present throughout backup creation; recovery validates advisory backups.
			try {
				await copyFile(target, `${filePath}.bak`);
				await chmod(`${filePath}.bak`, mode);
			} catch (error) {
				options.onWarning(`could not refresh backup for ${filePath}`, error);
			}
		}
		for (let attempt = 0; ; attempt++) {
			let temporary: string | undefined;
			try {
				await publishAtomic(target, contents, {
					encoding: "utf8",
					fsync: true,
					mode,
					...(metadata && process.platform !== "win32" ? { chown: { uid: metadata.uid, gid: metadata.gid } } : {}),
					async tmpfileCreated(path) {
						temporary = path;
						// Keep permission failures explicit; the library tolerates some chmod/chown errors.
						if (metadata && process.platform !== "win32") await chown(path, metadata.uid, metadata.gid);
						await chmod(path, mode);
					},
				});
				break;
			} catch (error) {
				if (temporary) {
					try {
						await unlink(temporary);
					} catch (cleanupError) {
						if (errorCode(cleanupError) !== "ENOENT")
							throw new AggregateError([error, cleanupError], `Atomic write and cleanup failed: ${target}`);
					}
				}
				const code = errorCode(error);
				if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || attempt >= WINDOWS_RETRY_LIMIT)
					throw error;
				await delay(WINDOWS_RETRY_STEP_MS * (attempt + 1));
			}
		}
		try {
			await fsyncDirectory(dirname(target));
		} catch (error) {
			options.onWarning(`could not fsync directory for ${target}`, error);
		}
	}
	const start = (filePath: string, contents: string): Promise<void> => {
		const publication = publish(filePath, contents).finally(() => {
			active.delete(filePath);
			const next = queued.get(filePath);
			if (!next) return;
			queued.delete(filePath);
			start(filePath, next.contents).then(next.resolve, next.reject);
		});
		active.set(filePath, publication);
		return publication;
	};
	return (filePath: string, contents: string): Promise<void> => {
		if (!active.has(filePath)) return start(filePath, contents);
		const waiting = queued.get(filePath);
		if (waiting) {
			waiting.contents = contents;
			return waiting.publication;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		queued.set(filePath, { contents, publication: promise, resolve, reject });
		return promise;
	};
}
