import type { ToolExecutionProgress } from "@ling/contracts/session-tool-progress";
import type {
	AutoRetryStatus,
	SessionCommandCatalog,
	SessionRef,
	SummarizationRetryStatus,
} from "@ling/contracts/session";
import type { ApprovalRequester, ExtensionUiRequester } from "@ling/core/pi-protocol/extension-ui";
import type { SessionEventStream } from "./session-event-stream";
import type { SessionFileSyncController } from "./session-file-sync";
import type { SessionChangeReviewEventListener, SessionEventListener } from "./session-lifecycle-events";
import type { SessionQueueController } from "./session-queue";
import type { SessionResourceReloadController } from "./session-resource-reload";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type { TranscriptPager } from "../transcript-pager";

export interface ManagedSession {
	toolExecutions: readonly ToolExecutionProgress[];
	ref: SessionRef;
	session: SessionRuntimePort;
	cwd: string;
	unsubscribeAgent: () => void;
	unsubscribeReplacementCoordinator: () => void;
	unsubscribeReplacement: () => void;
	unsubscribeSnapshotChanged: () => void;
	unsubscribeTranscriptInvalidated: () => void;
	unsubscribeTranscriptProjectionChanged: () => void;
	unsubscribeLifecycleFailure: () => void;
	listeners: Set<SessionEventListener>;
	changeReviewListeners: Set<SessionChangeReviewEventListener>;
	/** Set for the whole disposeManagedSession body so in-flight replace cannot re-arm hosts. */
	disposing: boolean;
	/** Monotonic access order used to retire only the least-recently-used idle runtimes. */
	lastAccessSequence: number;
	createdAt: number;
	placeholderTitle: string;
	autoTitleEnabled: boolean;
	autoTitleInFlight: boolean;
	lifecycleEpoch: number;
	titleRevision: number;
	commandCatalogRevision: number;
	extensionUiRevision: number;
	/** Runtime reconstruction can emit new UI state before its event stream rolls over. */
	extensionUiEventsSuspended: boolean;
	extensionUiChangePending: boolean;
	commandCatalog: SessionCommandCatalog;
	queue: SessionQueueController;
	summarizationRetry: SummarizationRetryStatus | null;
	autoRetry: AutoRetryStatus | null;
	eventStream: SessionEventStream;
	transcriptPager: TranscriptPager;
	extensionUiRequester?: ExtensionUiRequester;
	approvalRequester?: ApprovalRequester;
	fileSync: SessionFileSyncController;
	resourceReload: SessionResourceReloadController;
}
