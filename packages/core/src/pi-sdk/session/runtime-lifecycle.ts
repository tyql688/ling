import type { SessionRef } from "@ling/contracts/session";

export type PiSessionLifecycleState = "active" | "replacing" | "disposing" | "disposed";

type PiSessionLifecycleConflictError = Error & {
	code: "SESSION_LIFECYCLE_CONFLICT";
	operation: "access" | "replace" | "reload";
	state: Exclude<PiSessionLifecycleState, "active">;
};

export function sessionLifecycleConflict(
	operation: PiSessionLifecycleConflictError["operation"],
	state: PiSessionLifecycleConflictError["state"],
): PiSessionLifecycleConflictError {
	return Object.assign(new Error(`Cannot ${operation} session while lifecycle state is ${state}`), {
		code: "SESSION_LIFECYCLE_CONFLICT" as const,
		operation,
		state,
	});
}

export function sessionResourceReloadBusy(
	ref: SessionRef,
	message = `Cannot reload resources while session ${ref.sessionId} is busy`,
): Error & {
	code: "SESSION_RESOURCE_RELOAD_BUSY";
	ref: SessionRef;
} {
	return Object.assign(new Error(message), {
		code: "SESSION_RESOURCE_RELOAD_BUSY" as const,
		ref,
	});
}

export function sessionReplacementBusy(ref: SessionRef): Error & {
	code: "SESSION_REPLACEMENT_BUSY";
	ref: SessionRef;
} {
	return Object.assign(new Error(`Cannot replace session ${ref.sessionId} while another runtime operation is active`), {
		code: "SESSION_REPLACEMENT_BUSY" as const,
		ref,
	});
}
