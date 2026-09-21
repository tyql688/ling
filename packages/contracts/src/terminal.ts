import type { z } from "zod";
import type * as requestSchemas from "./terminal-validation";
type RequestSchemasShape = ReturnType<typeof requestSchemas.createTerminalRequestSchemas>;
/** Max length of a terminal-instance id; a short identifier addresses a PTY, and this keeps abnormally long ids out of maps/IPC. */
export const TERMINAL_ID_MAX_CHARS = 128;
/** Max length of a profile id; accommodates ids derived from system shell paths while bounding the config payload. */
export const TERMINAL_PROFILE_ID_MAX_CHARS = 1_024;
/** Max characters per stdin write; keeps a paste/script from overwhelming the main→PTY bridge buffer in one shot. */
export const TERMINAL_INPUT_MAX_CHARS = 64 * 1_024;
/** Max characters per stdout push chunk; output is streamed in chunks so no single event carries an unbounded payload that stalls the renderer. */
export const TERMINAL_OUTPUT_CHUNK_MAX_CHARS = 64 * 1_024;
/** Hard cap on columns; a resize guard that stops the PTY/renderer from allocating buffers for extreme geometry. */
export const TERMINAL_MAX_COLUMNS = 500;
/** Hard cap on rows; the row counterpart of the column resize guard. */
export const TERMINAL_MAX_ROWS = 300;

export type TerminalProfileSource = "environment" | "system" | "path";

/** A detected shell that main has approved for spawning. Renderer never supplies an executable path. */
export interface TerminalProfile {
	id: string;
	name: string;
	path: string;
	args: string[];
	source: TerminalProfileSource;
}

export interface TerminalProfilesSnapshot {
	profiles: TerminalProfile[];
	suggestedProfileId: string;
	/** User-configured default; null follows suggestedProfileId. */
	configuredProfileId: string | null;
}

export interface TerminalExitInfo {
	exitCode: number | null;
	signal: number | null;
	reason: "process" | "killed" | "hostLost";
}

export interface TerminalSnapshot {
	id: string;
	cwd: string;
	profileId: string;
	profileName: string;
	pid: number;
	createdAt: number;
	generation: number;
	status: "running" | "exited";
	exit: TerminalExitInfo | null;
}

export type TerminalCreateRequest = z.infer<RequestSchemasShape["terminalCreateRequestSchema"]>;

export type TerminalRefRequest = z.infer<RequestSchemasShape["terminalRefRequestSchema"]>;

export type TerminalInputRequest = z.infer<RequestSchemasShape["terminalInputRequestSchema"]>;

export type TerminalResizeRequest = z.infer<RequestSchemasShape["terminalResizeRequestSchema"]>;

export type TerminalAckRequest = z.infer<RequestSchemasShape["terminalAckRequestSchema"]>;

/** One ordered host-output unit. `ackRequired` is false for already-rendered replay after reload. */
export interface TerminalOutputChunk extends TerminalRefRequest {
	sequence: number;
	data: string;
	ackUnits: number;
	ackRequired: boolean;
}

export interface TerminalAttachResult {
	snapshot: TerminalSnapshot;
	chunks: TerminalOutputChunk[];
	/** Oldest output was evicted from the bounded replay buffer. */
	truncated: boolean;
	/** Sequence the host will assign to its next output chunk. */
	nextSequence: number;
}

export type TerminalEvent =
	| { type: "output"; chunk: TerminalOutputChunk }
	| { type: "exit"; snapshot: TerminalSnapshot }
	| { type: "removed"; ref: TerminalRefRequest };
