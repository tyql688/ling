import { createLogger } from "@ling/core/logger";
import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";

const log = createLogger("session-file-sync");

/**
 * Debounce interval for external session-file change detection. Coalesces fs.watch bursts;
 * shorter than a human-perceived "file changed" delay, longer than the multi-event jitter of one editor save.
 */
const EXTERNAL_CHECK_DEBOUNCE_MS = 300;

interface SessionFileStamp {
	mtimeMs: number;
	size: number;
}

interface SessionFileBaseline {
	file: string;
	stamp: SessionFileStamp | null;
}

function sameSessionFileStamp(left: SessionFileStamp | null, right: SessionFileStamp | null): boolean {
	if (left === null || right === null) return left === right;
	return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

interface RefreshDecisionInput {
	/** A streaming session is already receiving its own writes — never reload under it. */
	busy: boolean;
	/** Current on-disk stamp; `null` when the file is missing or has never been written. */
	disk: SessionFileStamp | null;
	/** Last stamp Ling wrote or accepted; `null` before the first observation. */
	baseline: SessionFileStamp | null;
}

/** The one divergence predicate both sides share. No baseline yet (fresh session, file
 * not written) or no file on disk means nothing to diverge from — the SDK owns those. */
function hasDiverged(disk: SessionFileStamp | null, baseline: SessionFileStamp | null): boolean {
	if (disk === null || baseline === null) return false;
	return !sameSessionFileStamp(disk, baseline);
}

/** Whether the transcript should be reloaded from disk after an external change. */
function shouldRefreshFromDisk(input: RefreshDecisionInput): boolean {
	if (input.busy) return false;
	return hasDiverged(input.disk, input.baseline);
}

/**
 * Whether a new prompt must be blocked because the file changed under Ling.
 * While the runtime is busy, JSONL advances are Pi's own appends — same busy
 * fence as shouldRefreshFromDisk. Blocking mid-turn would false-positive on
 * every steer/followUp during streaming.
 */
function sendBlockedByDivergence(
	disk: SessionFileStamp | null,
	baseline: SessionFileStamp | null,
	busy: boolean,
): boolean {
	if (busy) return false;
	return hasDiverged(disk, baseline);
}

/** Busy / lifecycle races during refresh are expected; only unrecoverable errors fail-closed. */
function isTransientExternalRefreshError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	return (
		code === "SESSION_REPLACEMENT_BUSY" ||
		code === "SESSION_REPLACEMENT_TARGET_BUSY" ||
		code === "SESSION_REPLACEMENT_STALE" ||
		code === "SESSION_RESOURCE_RELOAD_BUSY" ||
		code === "SESSION_LIFECYCLE_CONFLICT"
	);
}

type SessionFileRuntime = Pick<SessionRuntimePort, "isBusy" | "refreshFromDisk" | "sessionFile">;

interface SessionFileSyncOptions {
	runtime: () => SessionFileRuntime;
	isCurrent: () => boolean;
	sessionId: () => string;
	/** Fail-closed when file observation or external refresh cannot recover; no soft retries. */
	onSyncFailed: (error: unknown) => void;
}

export interface SessionFileSyncController {
	/** Accept the current disk stamp as a write already represented by the live runtime. */
	acceptCurrentState(): Promise<void>;
	/** Check whether another writer advanced the file beyond the accepted runtime state. */
	hasExternalDivergence(): Promise<boolean>;
	/** Debounce an external-change check; safe to call after a blocked mutation. */
	scheduleExternalCheck(): void;
	/** Release watcher, timer, and baseline ownership. */
	stop(): void;
}

export function createSessionFileSyncController(options: SessionFileSyncOptions): SessionFileSyncController {
	let baseline: SessionFileBaseline | null = null;
	let fileWatcher: FSWatcher | null = null;
	let watchedFile: string | null = null;
	let externalCheckTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshingFromDisk = false;
	let acceptRevision = 0;
	/** In-flight accept so send checks never race a just-finished run's baseline update. */
	let acceptInFlight: Promise<void> | null = null;

	async function statSessionFile(file: string | undefined): Promise<SessionFileStamp | null> {
		if (!file) return null;
		try {
			const info = await stat(file);
			return { mtimeMs: info.mtimeMs, size: info.size };
		} catch (error) {
			// A missing file is the deferred-first-write case; every other read failure is unknown state.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	function failSync(message: string, error: unknown): void {
		log.error(`${message} for ${options.sessionId()}:`, error);
		options.onSyncFailed(error);
	}

	function acceptedStampFor(file: string | undefined): SessionFileStamp | null {
		if (file === undefined || baseline === null || baseline.file !== file) return null;
		return baseline.stamp;
	}

	function releaseFileWatch(): void {
		if (externalCheckTimer) {
			clearTimeout(externalCheckTimer);
			externalCheckTimer = null;
		}
		fileWatcher?.close();
		fileWatcher = null;
		watchedFile = null;
	}

	function stop(): void {
		acceptRevision += 1;
		acceptInFlight = null;
		releaseFileWatch();
		baseline = null;
	}

	function ensureFileWatch(file: string): void {
		if (watchedFile === file) return;
		releaseFileWatch();
		try {
			const watcher = watch(file, scheduleExternalCheck);
			watcher.on("error", (error) => {
				if (fileWatcher === watcher) {
					fileWatcher = null;
					watchedFile = null;
				}
				watcher.close();
				failSync("session file watcher failed", error);
			});
			fileWatcher = watcher;
			watchedFile = file;
		} catch (error) {
			// The file can vanish between the sessionFile read and watch(); the next
			// acceptCurrentState retries once it exists again.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			failSync("could not watch session file", error);
		}
	}

	async function checkExternalChange(): Promise<void> {
		if (refreshingFromDisk || !options.isCurrent()) return;
		// Drain a concurrent accept, exactly as hasExternalDivergence does: every accept call site
		// is fire-and-forget, so a stamp still in flight would read as divergence and refresh the
		// runtime for a write Ling made itself.
		if (acceptInFlight) await acceptInFlight;
		if (refreshingFromDisk || !options.isCurrent()) return;
		const runtime = options.runtime();
		const file = runtime.sessionFile;
		let disk: SessionFileStamp | null;
		try {
			disk = await statSessionFile(file);
		} catch (error) {
			failSync("could not stat session file", error);
			return;
		}
		if (!options.isCurrent() || options.runtime() !== runtime || runtime.sessionFile !== file) return;
		const acceptedStamp = acceptedStampFor(file);
		if (!shouldRefreshFromDisk({ busy: runtime.isBusy(), disk, baseline: acceptedStamp })) return;
		refreshingFromDisk = true;
		try {
			await runtime.refreshFromDisk();
		} catch (error) {
			if (isTransientExternalRefreshError(error)) {
				// A prompt/replace may have started between the idle check and replace().
				// Reschedule; do not tear down the managed session for a busy race.
				log.warn(`deferred external session-file refresh for ${options.sessionId()} (transient):`, error);
				if (options.isCurrent()) scheduleExternalCheck();
			} else {
				// Fail-closed for unrecoverable refresh — no silent permanent SESSION_FILE_DIVERGED.
				failSync("failed to refresh session from disk", error);
			}
		} finally {
			refreshingFromDisk = false;
		}
	}

	function scheduleExternalCheck(): void {
		if (externalCheckTimer) clearTimeout(externalCheckTimer);
		externalCheckTimer = setTimeout(() => {
			externalCheckTimer = null;
			void checkExternalChange();
		}, EXTERNAL_CHECK_DEBOUNCE_MS);
	}

	return {
		async acceptCurrentState() {
			acceptRevision += 1;
			const revision = acceptRevision;
			const work = (async () => {
				const runtime = options.runtime();
				const file = runtime.sessionFile;
				let current: SessionFileStamp | null;
				try {
					current = await statSessionFile(file);
				} catch (error) {
					failSync("could not accept session file state", error);
					return;
				}
				if (
					revision !== acceptRevision ||
					!options.isCurrent() ||
					options.runtime() !== runtime ||
					runtime.sessionFile !== file
				) {
					return;
				}
				if (watchedFile !== file) releaseFileWatch();
				baseline = file === undefined ? null : { file, stamp: current };
				// Pi allocates a session path before the first assistant message persists it.
				// Watch only after that path has actually appeared.
				if (file !== undefined && current !== null) ensureFileWatch(file);
			})();
			const tracked: Promise<void> = work.finally(() => {
				if (acceptInFlight === tracked) acceptInFlight = null;
			});
			acceptInFlight = tracked;
			await tracked;
		},
		async hasExternalDivergence() {
			// Drain a concurrent accept so post-runFinished / messagePersisted stamps land first.
			if (acceptInFlight) await acceptInFlight;
			const revision = acceptRevision;
			const runtime = options.runtime();
			const file = runtime.sessionFile;
			let disk: SessionFileStamp | null;
			try {
				disk = await statSessionFile(file);
			} catch (error) {
				failSync("could not stat session file before mutation", error);
				throw error;
			}
			if (
				revision !== acceptRevision ||
				!options.isCurrent() ||
				options.runtime() !== runtime ||
				runtime.sessionFile !== file
			) {
				return false;
			}
			const acceptedStamp = acceptedStampFor(file);
			return sendBlockedByDivergence(disk, acceptedStamp, runtime.isBusy());
		},
		scheduleExternalCheck,
		stop,
	};
}
