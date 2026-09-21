import type { SessionCommandCatalog, SessionRef } from "@ling/contracts/session";
import type { PiRuntimeClient } from "./runtime-client";
import type {
	SessionRuntimeEvent,
	SessionRuntimeReplacementCoordinator,
	SessionRuntimeReplacementEvent,
	SessionRuntimeResourceSnapshot,
	SessionRuntimeSnapshot,
	SessionRuntimeStateSnapshot,
	SessionRuntimeSummary,
	SessionRuntimeTranscriptInvalidationReason,
	SessionRuntimeTranscriptProjectionReason,
} from "./runtime-types";

/**
 * Application-owned view of the Pi runtime. It intentionally excludes raw Pi models,
 * session managers, resource loaders, extension runners, and lifecycle implementation state.
 */
export interface SessionRuntimePort extends Omit<
	PiRuntimeClient,
	"getSnapshot" | "getStateSnapshot" | "generateTitle" | "dispose"
> {
	readonly ref: SessionRef;
	readonly cwd: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;

	subscribe(listener: (event: SessionRuntimeEvent) => void): () => void;
	setReplacementCoordinator(coordinator: SessionRuntimeReplacementCoordinator): () => void;
	onSessionReplaced(listener: (event: SessionRuntimeReplacementEvent) => void): () => void;
	onSnapshotChanged(listener: (ref: SessionRef) => void): () => void;
	onTranscriptInvalidated(
		listener: (ref: SessionRef, reason: SessionRuntimeTranscriptInvalidationReason) => void,
	): () => void;
	onTranscriptProjectionChanged(
		listener: (ref: SessionRef, reason: SessionRuntimeTranscriptProjectionReason) => void,
	): () => void;
	onLifecycleFailed(
		listener: (ref: SessionRef, error: unknown, relatedRefs: readonly SessionRef[]) => void,
	): () => void;

	getSessionName(): string | undefined;
	generateTitle(userMessage: string): Promise<string | undefined>;
	summarize(createdAt: number, placeholderTitle: string): SessionRuntimeSummary;

	/** Whether lifecycle work, a runtime operation, agent run, retry, compaction,
	 * queued continuation, or resource reload currently owns the session. */
	isBusy(): boolean;

	listCommands(): SessionCommandCatalog;
	releaseExtensionUi(ref: SessionRef): void;
	getStateSnapshot(): Promise<SessionRuntimeStateSnapshot>;
	getStateSnapshotAtBoundary<Boundary>(
		captureBoundary: (snapshot: SessionRuntimeStateSnapshot) => Boundary,
	): Promise<{ snapshot: SessionRuntimeStateSnapshot; boundary: Boundary }>;
	getSnapshot(): Promise<SessionRuntimeSnapshot>;
	getSnapshotAtBoundary<Boundary>(
		captureBoundary: (snapshot: SessionRuntimeSnapshot) => Boundary,
	): Promise<{ snapshot: SessionRuntimeSnapshot; boundary: Boundary }>;
	getResourceSnapshot(): SessionRuntimeResourceSnapshot;
	dispose(): Promise<void>;
}

export type SessionRuntimeForkSource = Pick<SessionRuntimePort, "cwd" | "sessionFile">;
