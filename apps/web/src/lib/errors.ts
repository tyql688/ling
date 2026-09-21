import { errorMessage, lingErrorDtoSchema, type LingErrorCode } from "@ling/contracts/ling-error";
import i18next from "i18next";

/**
 * Error codes that require a full-snapshot transcript resync.
 * These mean the projection generation/cursor is invalid and partial patches can't be
 * trusted — clear and refetch.
 */
const TRANSCRIPT_RESYNC_CODES = new Set<LingErrorCode>([
	"STALE_RUNTIME_GENERATION",
	"STALE_TRANSCRIPT_REVISION",
	"TRANSCRIPT_CURSOR_INVALID",
	"TRANSCRIPT_CURSOR_EXPIRED",
]);

export function transcriptErrorNeedsSnapshot(error: unknown): boolean {
	return TRANSCRIPT_RESYNC_CODES.has(requestErrorCode(error) as LingErrorCode);
}

/** Cursor pin was dropped (invalidate / TTL) — recoverable via a fresh tail snapshot. */
export function isTranscriptCursorStale(error: unknown): boolean {
	return (
		requestErrorCode(error) === "TRANSCRIPT_CURSOR_EXPIRED" || requestErrorCode(error) === "TRANSCRIPT_CURSOR_INVALID"
	);
}

/** The project folder was deleted: its sessions can still be read, but not resumed. */
export function isProjectDirectoryMissing(error: unknown): boolean {
	return requestErrorCode(error) === "PROJECT_DIRECTORY_MISSING";
}

export function isExpectedCancellation(error: unknown): boolean {
	return requestErrorCode(error) === "REQUEST_CANCELLED";
}

export function isExpectedCompanionRace(error: unknown): boolean {
	return requestErrorCode(error) === "STALE_RUNTIME_GENERATION" || requestErrorCode(error) === "STALE_STATE_REVISION";
}

function requestErrorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error)) return null;
	return typeof error.code === "string" ? error.code : null;
}

type Translate = (key: string, options: Record<string, unknown>) => string;

const ERROR_COPY: Partial<Record<LingErrorCode, string>> = {
	INTERNAL_ERROR: "errors.requestFailed",
	REQUEST_DEADLINE_EXCEEDED: "errors.requestTimedOut",
	REQUEST_CAPACITY_EXCEEDED: "errors.requestBusy",
	PROJECT_NOT_OPEN: "errors.projectNotOpen",
	BUILTIN_FEATURE_DISABLED: "builtinFeatures.disabledError",
	PROJECT_DIRECTORY_MISSING: "errors.projectDirectoryMissing",
	HOST_DIRECTORY_UNAVAILABLE: "errors.hostDirectoryUnavailable",
	SESSION_NOT_FOUND: "errors.sessionNotFound",
	SESSION_LIFECYCLE_CONFLICT: "errors.sessionChanged",
	STALE_RUNTIME_GENERATION: "errors.sessionChanged",
	STALE_STATE_REVISION: "errors.sessionChanged",
	STALE_TRANSCRIPT_REVISION: "errors.sessionChanged",
	TRANSCRIPT_CURSOR_INVALID: "errors.historyChanged",
	TRANSCRIPT_CURSOR_EXPIRED: "errors.historyChanged",
	PACKAGE_HOST_LOST: "errors.packageHostLost",
};

/** Formats transported domain errors without parsing presentation copy. */
export function formatRequestError(error: unknown, t: Translate = i18next.t): string {
	const candidate = error instanceof Error && "lingError" in error ? error.lingError : error;
	const parsed = lingErrorDtoSchema.safeParse(candidate);
	if (!parsed.success) return errorMessage(error);
	const dto = parsed.data;
	if (dto.code !== "COMMAND_NOT_FOUND") {
		const key = ERROR_COPY[dto.code];
		const message = key === undefined ? dto.message : t(key, {});
		return dto.causeId ? `${message} (${dto.causeId})` : message;
	}
	const executable = dto.details?.executable;
	switch (executable) {
		case "npm":
			return t("errors.missingNpm", {});
		case "git":
			return t("errors.missingGit", {});
		default: {
			const label = dto.details?.label;
			return typeof label === "string" && label.length > 0
				? t("errors.missingExecutable", { executable: label })
				: dto.message;
		}
	}
}
