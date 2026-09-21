import { getCanonicalGitRoot } from "@ling/host/domains/git/git-service";
import { createLingError, requestCancelled, throwIfOperationAborted, waitForOperation } from "@ling/core/ling-error";
import { realpath } from "node:fs/promises";

interface BoundedGitWriteRecord {
	controller: AbortController;
	admitted: boolean;
	settlement: Promise<void>;
}
/**
 * Default deadline for a single Git write. 5min covers large commits/pushes on slow
 * disks; used when the caller sets no explicit limit, so the write queue is never held
 * forever by a child process that never exits.
 */
const DEFAULT_GIT_WRITE_DEADLINE_MS = 5 * 60 * 1000;

function deadlineError() {
	return createLingError({
		code: "REQUEST_DEADLINE_EXCEEDED",
		category: "lifecycle",
		message: "The Git write deadline expired before the operation started.",
		retryable: true,
		userAction: "retry",
	});
}

function uncertainError() {
	return createLingError({
		code: "GIT_OPERATION_UNCERTAIN",
		category: "external",
		message: "The Git write exceeded its deadline after starting; inspect the repository before retrying.",
		retryable: false,
		userAction: "report",
	});
}

function shutdownCancellationError() {
	return requestCancelled("The Git write was cancelled because Ling is shutting down.");
}

export function createGitWriteQueue() {
	const writeTails = new Map<string, Promise<void>>();

	const boundedGitWrites = new Set<BoundedGitWriteRecord>();
	let shutdownPromise: Promise<void> | null = null;
	let shuttingDown = false;

	/** Serializes every in-process Git mutation that targets the same canonical root.
	 * The rejected branch is normalized so one failed write never poisons later work. */
	function runGitWriteAtRoot<Result>(canonicalGitRootOrCwd: string, operation: () => Promise<Result>): Promise<Result> {
		const previous = writeTails.get(canonicalGitRootOrCwd);
		const running = previous === undefined ? Promise.resolve().then(operation) : previous.then(operation);
		const tail = running.then(
			() => undefined,
			() => undefined,
		);
		writeTails.set(canonicalGitRootOrCwd, tail);
		return running.finally(() => {
			if (writeTails.get(canonicalGitRootOrCwd) === tail) writeTails.delete(canonicalGitRootOrCwd);
		});
	}

	/** Stops admitting bounded writes, aborts every current root-discovery/queued/admitted
	 * operation, and waits for the underlying root tails to settle. Admitted writes remain
	 * uncertain because Git may already have changed repository state. The application-level
	 * shutdown coordinator supplies the outer deadline if a child ignores cancellation. */
	function shutdownGitWriteQueue(): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		shuttingDown = true;
		shutdownPromise = (async () => {
			while (boundedGitWrites.size > 0) {
				const records = [...boundedGitWrites];
				for (const record of records) {
					if (!record.controller.signal.aborted) {
						record.controller.abort(record.admitted ? uncertainError() : shutdownCancellationError());
					}
				}
				await Promise.all(records.map((record) => record.settlement));
			}
		})();
		return shutdownPromise;
	}

	/** Gives every regular Git mutation a total deadline that includes root discovery and
	 * queue wait. A queued timeout never enters the operation. Once admitted, cancellation
	 * is conservative because Git may have applied part or all of the mutation before its
	 * child process observed AbortSignal. The root tail still owns the underlying promise,
	 * so a timed-out caller cannot let a later write overlap the settling process. */
	async function runBoundedGitWrite<Result>(
		resolveKey: (signal: AbortSignal) => Promise<string>,
		operation: (signal: AbortSignal) => Promise<Result>,
	): Promise<Result> {
		if (shuttingDown) throw shutdownCancellationError();
		const controller = new AbortController();
		const record: BoundedGitWriteRecord = {
			controller,
			admitted: false,
			settlement: Promise.resolve(),
		};
		const timer = setTimeout(() => {
			controller.abort(record.admitted ? uncertainError() : deadlineError());
		}, DEFAULT_GIT_WRITE_DEADLINE_MS);
		timer.unref();

		const work = (async () => {
			const key = await resolveKey(controller.signal);
			throwIfOperationAborted(controller.signal);
			return runGitWriteAtRoot(key, async () => {
				throwIfOperationAborted(controller.signal);
				record.admitted = true;
				try {
					return await operation(controller.signal);
				} catch (error) {
					if (controller.signal.aborted) throw uncertainError();
					throw error;
				}
			});
		})();
		record.settlement = work.then(
			() => undefined,
			() => undefined,
		);
		boundedGitWrites.add(record);
		void record.settlement.then(() => boundedGitWrites.delete(record));

		try {
			return await waitForOperation(work, controller.signal);
		} finally {
			clearTimeout(timer);
		}
	}

	function runBoundedGitWriteAtRoot<Result>(
		canonicalGitRoot: string,
		operation: (signal: AbortSignal) => Promise<Result>,
	): Promise<Result> {
		return runBoundedGitWrite(async () => canonicalGitRoot, operation);
	}

	function runBoundedGitWriteForWorkspace<Result>(
		canonicalCwd: string,
		operation: (signal: AbortSignal) => Promise<Result>,
	): Promise<Result> {
		return runBoundedGitWrite(async (signal) => {
			const gitRoot = await getCanonicalGitRoot(canonicalCwd, signal);
			throwIfOperationAborted(signal);
			return gitRoot === null ? realpath(canonicalCwd) : gitRoot;
		}, operation);
	}
	return { runBoundedGitWriteAtRoot, runBoundedGitWriteForWorkspace, dispose: shutdownGitWriteQueue };
}

export type GitWriteQueue = ReturnType<typeof createGitWriteQueue>;
