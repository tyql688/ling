import type { BoundedJsonObject } from "@ling/contracts/bounded-json";
import type { ModelLoginEvent } from "@ling/contracts/model";
import type { ProjectPiConfig } from "@ling/contracts/project";
import type { ExtensionUiStateEvent, SessionCommandCatalog, SessionRef } from "@ling/contracts/session";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import type {
	SessionCatalogDiscovery,
	SessionCatalogInfo,
	SessionRuntimeEvent,
	SessionRuntimeReplacementEvent,
	SessionRuntimeResourceSnapshot,
	SessionRuntimeSnapshot,
	SessionRuntimeStateSnapshot,
	SessionRuntimeTranscriptInvalidationReason,
	SessionRuntimeTranscriptProjectionReason,
} from "@ling/core/pi-protocol/runtime-types";
import type { PiWorkerMainMethod } from "./callback-methods";
import type { PiWorkerMethod, PiMethodParams } from "./methods";
import type { PI_WORKER_PROTOCOL_VERSION } from "./wire-format";

export type PiWorkerProjectPiConfig = ProjectPiConfig;

export interface PiWorkerProjectSnapshot {
	cwd: string;
	diagnostics: PiDiagnostic[];
}

export type PiWorkerSessionInfo = SessionCatalogInfo;
export type PiWorkerSessionDiscovery = SessionCatalogDiscovery;

export interface PiWorkerErrorDto {
	code: string;
	message: string;
	retryable: boolean;
	category?: string | undefined;
	userAction?: string | undefined;
	details?: BoundedJsonObject | undefined;
}

export interface PiWorkerRuntimeState {
	revision: number;
	ref: SessionRef;
	sessionFile: string | null;
	sessionName: string | null;
	snapshot: SessionRuntimeStateSnapshot;
	commandCatalog: SessionCommandCatalog;
	resources: SessionRuntimeResourceSnapshot;
	summary: {
		sessionFilePath: string;
		parentSessionFilePath?: string;
		manualFork?: boolean;
		storedTitle: string;
		updatedAt: number;
		messageCount: number;
		preview: string;
		transcriptCacheKey: string | null;
	};
}

export interface PiWorkerRuntimeBootstrap {
	runtimeId: string;
	state: PiWorkerRuntimeState;
}

export interface PiWorkerRuntimeSnapshotResult {
	ref: SessionRef;
	snapshot: SessionRuntimeSnapshot;
	eventSequence: number;
}

export interface PiWorkerRuntimeStateSnapshotResult {
	ref: SessionRef;
	snapshot: SessionRuntimeStateSnapshot;
	eventSequence: number;
}

export type PiWorkerCreateRuntimeParams = PiMethodParams<"runtime.create">;

export type PiWorkerResumeRuntimeParams = PiMethodParams<"runtime.resume">;

export type PiWorkerForkRuntimeParams = PiMethodParams<"runtime.fork">;

export type PiWorkerRequest = {
	kind: "request";
	protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
	generation: number;
	requestId: string;
	method: PiWorkerMethod;
	deadlineAt: number;
	params: unknown;
};

export type PiWorkerCancel = {
	kind: "cancel";
	protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
	generation: number;
	requestId: string;
};

export type PiWorkerResponse =
	| {
			kind: "result";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			requestId: string;
			method: PiWorkerMethod;
			result: unknown;
	  }
	| {
			kind: "error";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			requestId: string;
			method: PiWorkerMethod;
			error: PiWorkerErrorDto;
	  };

export type PiWorkerResponseChunk = {
	kind: "resultChunk";
	protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
	generation: number;
	requestId: string;
	method: PiWorkerMethod;
	sequence: number;
	final: boolean;
	data: string;
};

export type PiWorkerResponseFrame = PiWorkerResponse | PiWorkerResponseChunk;

export type PiWorkerMainRequest = {
	kind: "mainRequest";
	protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
	generation: number;
	requestId: string;
	method: PiWorkerMainMethod;
	deadlineAt: number | null;
	params: unknown;
};

export type PiWorkerMainResponse =
	| {
			kind: "mainResult";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			requestId: string;
			method: PiWorkerMainMethod;
			result: unknown;
	  }
	| {
			kind: "mainError";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			requestId: string;
			method: PiWorkerMainMethod;
			error: PiWorkerErrorDto;
	  };

export type PiWorkerMainCancel = {
	kind: "mainCancel";
	protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
	generation: number;
	requestId: string;
};

export type PiWorkerEvent =
	| {
			kind: "runtimeEvent";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			event: SessionRuntimeEvent;
	  }
	| {
			kind: "runtimeState";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			state: PiWorkerRuntimeState;
	  }
	| {
			kind: "runtimeBusy";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			busy: boolean;
	  }
	| {
			kind: "runtimeReplaced";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			event: SessionRuntimeReplacementEvent;
			state: PiWorkerRuntimeState;
	  }
	| {
			kind: "runtimeSnapshotChanged";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			ref: SessionRef;
			state: PiWorkerRuntimeState;
	  }
	| {
			kind: "runtimeTranscriptInvalidated";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			ref: SessionRef;
			reason: SessionRuntimeTranscriptInvalidationReason;
			state: PiWorkerRuntimeState;
	  }
	| {
			kind: "runtimeTranscriptProjectionChanged";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			ref: SessionRef;
			reason: SessionRuntimeTranscriptProjectionReason;
	  }
	| {
			kind: "runtimeLifecycleFailed";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			ref: SessionRef;
			error: PiWorkerErrorDto;
			relatedRefs: SessionRef[];
	  }
	| {
			kind: "extensionUiState";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			runtimeId: string;
			sequence: number;
			ref: SessionRef;
			event: ExtensionUiStateEvent;
	  }
	| {
			kind: "modelCatalogChanged";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			sequence: number;
	  }
	| {
			kind: "modelLoginEvent";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			sequence: number;
			flowId: string;
			event: ModelLoginEvent;
	  }
	| {
			kind: "modelOpenExternal";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			sequence: number;
			flowId: string;
			url: string;
	  };

export type PiWorkerRuntimeEvent = Exclude<
	Extract<PiWorkerEvent, { runtimeId: string }>,
	Extract<PiWorkerEvent, { kind: "extensionUiState" }>
>;

export type PiWorkerDomainEvent = Extract<
	PiWorkerEvent,
	{ kind: "modelCatalogChanged" | "modelLoginEvent" | "modelOpenExternal" }
>;

export type PiWorkerControlFrame =
	| PiWorkerRequest
	| PiWorkerCancel
	| PiWorkerResponseFrame
	| PiWorkerMainRequest
	| PiWorkerMainResponse
	| PiWorkerMainCancel
	| PiWorkerEvent
	| {
			kind: "ready";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			pid: number;
			piVersion: string;
	  }
	| {
			kind: "shutdown";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
	  }
	| {
			kind: "shutdownComplete";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
	  };

export type PiWorkerParentMessage =
	| {
			kind: "attachControl";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			systemProxyFallback: string | null;
	  }
	| { kind: "ping"; protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION; generation: number; sentAt: number }
	| {
			kind: "pong";
			protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION;
			generation: number;
			sentAt: number;
			/** V8 old-space usage and the subprocess's fixed limit. */
			heapUsedBytes: number;
			heapLimitBytes: number;
			/** Largest event-loop delay observed since the previous pong. */
			eventLoopDelayMs: number;
	  }
	| { kind: "shutdown"; protocolVersion: typeof PI_WORKER_PROTOCOL_VERSION; generation: number };
