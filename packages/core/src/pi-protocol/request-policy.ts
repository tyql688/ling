/** Ordinary in-memory operations should fail quickly enough for the UI to remain responsive. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Filesystem and network reads may legitimately take longer without implying a wedged Pi worker. */
export const IO_REQUEST_TIMEOUT_MS = 2 * 60_000;
/** Project and runtime lifecycle work may need to load every persisted resource. */
export const LIFECYCLE_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** Model-backed operations own their cancellation and may remain active for an entire long turn. */
export const LONG_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;

type PiWorkerRequestKind = "recoverableQuery" | "runtimeQuery" | "command";

export interface PiWorkerRequestPolicy {
	readonly kind: PiWorkerRequestKind;
	readonly timeoutMs: number;
	readonly deferHeartbeat: boolean;
}

interface PolicyOptions {
	timeoutMs?: number;
	deferHeartbeat?: boolean;
}

function requestPolicy(kind: PiWorkerRequestKind, options: PolicyOptions): PiWorkerRequestPolicy {
	return {
		kind,
		timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		deferHeartbeat: options.deferHeartbeat ?? false,
	};
}

/** Domain queries can reconstruct their inputs against a replacement generation. */
export function recoverableQuery(options: PolicyOptions = {}): PiWorkerRequestPolicy {
	return requestPolicy("recoverableQuery", options);
}

/** Runtime queries belong to a live session generation and therefore cannot be replayed after it exits. */
export function runtimeQuery(options: PolicyOptions = {}): PiWorkerRequestPolicy {
	return requestPolicy("runtimeQuery", options);
}

/** Commands may leave state changed even when their reply is lost or invalid. */
export function command(options: PolicyOptions = {}): PiWorkerRequestPolicy {
	return requestPolicy("command", options);
}
