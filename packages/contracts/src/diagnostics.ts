export type DiagnosticLogLevel = "info" | "warn" | "error";

export interface DiagnosticCorrelation {
	requestId?: string;
	operationId?: string;
	ownerId?: string;
	ownerRevision?: string;
	sessionId?: string;
	runtimeId?: string;
	generation?: number;
	revision?: number;
	code?: string;
	durationMs?: number;
	bytes?: number;
	count?: number;
}

type MetadataCleanupOwnerId = "sessionCatalog" | "changeReview";

export interface MetadataCleanupPendingSummary {
	summaryId: string;
	factType: "sessionDeleted" | "projectRemoved";
	pendingOwnerIds: MetadataCleanupOwnerId[];
	attempts: number;
	firstFailedAt: number;
	lastAttemptAt: number;
}

export type MetadataCleanupStatus =
	| {
			protocolVersion: 1;
			status: "ready";
			records: MetadataCleanupPendingSummary[];
	  }
	| {
			protocolVersion: 1;
			status: "recoveryRequired";
			errorCode: "DATASET_CORRUPT" | "DATASET_FUTURE_VERSION";
			foundVersion: number | null;
	  };

export interface MetadataCleanupRetryResult {
	protocolVersion: 1;
	attemptedRecords: number;
	completedRecords: number;
	remainingRecords: number;
	status: MetadataCleanupStatus;
}

export const DIAGNOSTIC_LOG_PAGE_MAX = 500;
export const DIAGNOSTIC_LOG_TEXT_MAX_CHARS = 200;

export interface DiagnosticLogRecord {
	id: number;
	/** Epoch milliseconds when the line was emitted. */
	at: number;
	level: DiagnosticLogLevel;
	/** Emitting Ling process label, such as `host`, `desktop` or `pi-session`. */
	process: string;
	component: string;
	message: string;
	correlation?: DiagnosticCorrelation;
}

export interface DiagnosticLogQuery {
	/** Newest first; rows with id below this. */
	beforeId?: number;
	/** Oldest first; rows with id above this, for following live output. */
	afterId?: number;
	limit?: number;
	levels?: DiagnosticLogLevel[];
	process?: string;
	component?: string;
	sessionId?: string;
	text?: string;
}

export interface DiagnosticLogPage {
	records: DiagnosticLogRecord[];
	/** Distinct process and component labels present in the store, for filter controls. */
	processes: string[];
	components: string[];
}

export type DiagnosticProcessRole = "pi-control" | "pi-session";

export interface DiagnosticProcess {
	id: string;
	role: DiagnosticProcessRole;
	pid: number | null;
	generation: number;
	state: "starting" | "ready" | "failed" | "stopping";
	startedAt: number;
	cwd?: string;
	sessionId?: string;
	heapUsedBytes: number;
	heapLimitBytes: number;
	eventLoopDelayMs: number;
	pendingRequests: number;
}
