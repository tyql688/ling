import { z } from "zod";

/** Closed set of error categories: the main boundary picks logging and UI recovery policy by category; do not add unmodeled categories. */
const LING_ERROR_CATEGORIES = ["validation", "lifecycle", "runtime", "compatibility", "external"] as const;

/** Closed set of suggested user actions: the renderer only renders these three recovery entries, so free-form copy never drives the flow. */
const LING_ERROR_USER_ACTIONS = ["retry", "reopenProject", "report"] as const;
export type LingErrorUserAction = (typeof LING_ERROR_USER_ACTIONS)[number];

/** Closed set of stable error codes: IPC/DTOs branch on code, never on message strings; additions/removals must stay in sync with main and the UI. */
const LING_ERROR_CODES = [
	"INVALID_REQUEST",
	"SESSION_NOT_FOUND",
	"SESSION_LIFECYCLE_CONFLICT",
	"SESSION_FILE_DIVERGED",
	"STALE_RUNTIME_GENERATION",
	"STALE_STATE_REVISION",
	"STALE_TRANSCRIPT_REVISION",
	"TRANSCRIPT_CURSOR_INVALID",
	"TRANSCRIPT_CURSOR_EXPIRED",
	"TRANSCRIPT_VIEW_TOO_LARGE",
	"TRANSCRIPT_ITEM_TOO_LARGE",
	"COMPANION_SNAPSHOT_TOO_LARGE",
	"REQUEST_CANCELLED",
	"REQUEST_DEADLINE_EXCEEDED",
	"REQUEST_CAPACITY_EXCEEDED",
	"REQUEST_ID_CONFLICT",
	"PROJECT_NOT_OPEN",
	"PROJECT_DIRECTORY_MISSING",
	"HOST_DIRECTORY_UNAVAILABLE",
	"PROJECT_FILE_WRITE_BLOCKED",
	"COMMAND_NOT_FOUND",
	"PI_CAPABILITY_UNSUPPORTED",
	"BUILTIN_FEATURE_DISABLED",
	"PACKAGE_HOST_LOST",
	"PACKAGE_OPERATION_FAILED",
	"PACKAGE_OPERATION_UNCERTAIN",
	"GIT_OPERATION_UNCERTAIN",
	"INTERNAL_ERROR",
] as const;
export type LingErrorCode = (typeof LING_ERROR_CODES)[number];

export type LingErrorDto = z.infer<typeof lingErrorDtoSchema>;

export const lingErrorDtoSchema = z.strictObject({
	code: z.enum(LING_ERROR_CODES),
	category: z.enum(LING_ERROR_CATEGORIES),
	message: z.string().min(1).max(2_000),
	retryable: z.boolean(),
	userAction: z.enum(LING_ERROR_USER_ACTIONS).optional(),
	details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
	causeId: z.string().min(1).max(128).optional(),
});

/** Uniform error-text extraction: take message from Error, String() everything else. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Normalizes an unknown thrown value into an Error at renderer-safe boundaries. */
export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Extracts a stable code from an unknown error without relying on its message. */
export function errorCode(error: unknown): string | null {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: null;
}
