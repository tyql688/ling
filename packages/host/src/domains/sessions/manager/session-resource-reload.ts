import { mergePiResourceReloadModes, type PiResourceReloadMode } from "@ling/contracts/session";
import { createLogger } from "@ling/core/logger";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";

const log = createLogger("session-resource-reload");

type ResourceReloadRuntime = Pick<SessionRuntimePort, "isBusy" | "reloadResources">;

interface SessionResourceReloadOptions {
	runtime: () => ResourceReloadRuntime;
	isCurrent: () => boolean;
	sessionId: () => string;
	track: (operation: Promise<void>) => Promise<void>;
	suspendExtensionUiEvents: () => void;
	resumeExtensionUiEvents: () => void;
	appliedRevisionAtCreation: number;
	latestRevisionAtCreation: number;
}

export interface SessionResourceReloadController {
	requestRevision(revision: number, mode?: PiResourceReloadMode): void;
	reconcile(revision: number): Promise<void>;
	triggerAfterCurrent(): void;
	hasApplied(revision: number): boolean;
	appliedRevision(): number;
	drain(): Promise<void>;
}

function isResourceReloadBusyError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const candidate = error as { code?: unknown; operation?: unknown; state?: unknown };
	return (
		candidate.code === "SESSION_RESOURCE_RELOAD_BUSY" ||
		(candidate.code === "SESSION_LIFECYCLE_CONFLICT" &&
			candidate.operation === "reload" &&
			candidate.state === "replacing")
	);
}

export function createSessionResourceReloadController(
	options: SessionResourceReloadOptions,
): SessionResourceReloadController {
	let appliedRevision = options.appliedRevisionAtCreation;
	let pendingRevision =
		options.appliedRevisionAtCreation < options.latestRevisionAtCreation ? options.latestRevisionAtCreation : 0;
	// A full reload admitted while busy must survive later configuration-only changes.
	let pendingMode: PiResourceReloadMode = pendingRevision > 0 ? "full" : "adapters";
	let reloadPromise: Promise<void> | null = null;
	let deferred = false;

	function schedule(): Promise<void> {
		if (reloadPromise) return reloadPromise;
		const operation: Promise<void> = options
			.track(
				(async () => {
					while (options.isCurrent()) {
						const targetRevision = pendingRevision;
						if (targetRevision <= appliedRevision) return;
						const runtime = options.runtime();
						if (deferred && runtime.isBusy()) return;
						options.suspendExtensionUiEvents();
						const mode = pendingMode;
						pendingMode = "adapters";
						try {
							await runtime.reloadResources(mode);
						} catch (error) {
							pendingMode = mergePiResourceReloadModes(pendingMode, mode);
							options.resumeExtensionUiEvents();
							if (isResourceReloadBusyError(error)) {
								deferred = true;
								return;
							}
							throw error;
						}
						if (!options.isCurrent()) return;
						// Joining after transcript invalidation may miss the handler that
						// normally resumes UI events; the callback is idempotent.
						options.resumeExtensionUiEvents();
						deferred = false;
						appliedRevision = Math.max(appliedRevision, targetRevision);
						if (pendingRevision <= appliedRevision) pendingRevision = 0;
					}
				})(),
			)
			.finally(() => {
				if (reloadPromise === operation) reloadPromise = null;
			});
		reloadPromise = operation;
		return operation;
	}

	async function reconcile(revision: number): Promise<void> {
		while (options.isCurrent() && appliedRevision < revision) {
			await schedule();
			if (appliedRevision >= revision || deferred || options.runtime().isBusy()) return;
		}
	}

	function trigger(): void {
		if (!options.isCurrent() || pendingRevision <= appliedRevision || options.runtime().isBusy()) return;
		deferred = false;
		void schedule().catch((error: unknown) => {
			log.error(`deferred resource reload failed for session ${options.sessionId()}:`, error);
			// Fail-closed reload already emits lifecycle failure when invalidation started.
			// Pre-invalidation failures only log here; surface them by disposing the managed
			// session via a second reconcile attempt is not safe. Leave the log — session
			// remains usable if generation was restored; busy sessions will retry after idle.
		});
	}

	return {
		requestRevision(revision, mode = "full") {
			if (revision <= appliedRevision) return;
			pendingMode = mergePiResourceReloadModes(pendingMode, mode);
			pendingRevision = Math.max(pendingRevision, revision);
		},
		reconcile,
		triggerAfterCurrent() {
			if (pendingRevision <= appliedRevision) return;
			const current = reloadPromise;
			if (!current) {
				queueMicrotask(trigger);
				return;
			}
			void current.finally(() => queueMicrotask(trigger)).catch(() => undefined);
		},
		hasApplied(revision) {
			return appliedRevision >= revision;
		},
		appliedRevision() {
			return appliedRevision;
		},
		async drain() {
			if (reloadPromise) await Promise.allSettled([reloadPromise]);
		},
	};
}
