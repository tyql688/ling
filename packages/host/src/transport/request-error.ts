import type { LingErrorCode, LingErrorDto } from "@ling/contracts/ling-error";
import { errorCode } from "@ling/contracts/ling-error";
import { isLingError } from "@ling/core/ling-error";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

function knownRequestError(code: string): Omit<LingErrorDto, "causeId"> | null {
	switch (code) {
		case "SESSION_RESOURCE_RELOAD_BUSY":
		case "SESSION_REPLACEMENT_BUSY":
		case "SESSION_LIFECYCLE_CONFLICT":
			return {
				code: "SESSION_LIFECYCLE_CONFLICT",
				category: "lifecycle",
				message: "The session runtime is changing. Retry when it is ready.",
				retryable: true,
				userAction: "retry",
			};
		case "TRANSCRIPT_CURSOR_INVALID":
			return {
				code,
				category: "validation",
				message: "The transcript cursor is no longer valid.",
				retryable: true,
				userAction: "retry",
			};
		case "TRANSCRIPT_CURSOR_EXPIRED":
			return {
				code,
				category: "lifecycle",
				message: "The transcript cursor expired.",
				retryable: true,
				userAction: "retry",
			};
		case "TRANSCRIPT_VIEW_TOO_LARGE":
		case "TRANSCRIPT_ITEM_TOO_LARGE":
			return {
				code,
				category: "compatibility",
				message: "The transcript exceeds the current bounded transport limits.",
				retryable: false,
				userAction: "report",
			};
		case "TRANSCRIPT_REVISION_CONFLICT":
			return {
				code: "STALE_TRANSCRIPT_REVISION",
				category: "lifecycle",
				message: "The transcript changed while it was being read.",
				retryable: true,
				userAction: "retry",
			};
		case "STALE_RUNTIME_GENERATION":
			return {
				code,
				category: "lifecycle",
				message: "The request targets an inactive runtime generation.",
				retryable: true,
				userAction: "retry",
			};
		default:
			return null;
	}
}

function validationError(error: ZodError): Omit<LingErrorDto, "causeId"> {
	const firstIssue = error.issues[0];
	const path = firstIssue?.path.map(String).join(".");
	return {
		code: "INVALID_REQUEST",
		category: "validation",
		message: "The request is invalid.",
		retryable: false,
		...(path
			? { details: { field: path, issueCount: error.issues.length } }
			: { details: { issueCount: error.issues.length } }),
	};
}

interface NormalizeRequestErrorOptions {
	causeId?: string;
	fallbackCode?: LingErrorCode;
	fallbackMessage: string;
}

/**
 * Error codes treated as in-protocol control flow rather than service failures. Stale
 * generation/revision, cancellation, and timeouts should be silent/retryable — do not
 * log them as main-process errors or toast them as "crashes".
 */
const EXPECTED_CONTROL_FLOW_CODES = new Set<LingErrorCode>([
	"SESSION_LIFECYCLE_CONFLICT",
	"STALE_RUNTIME_GENERATION",
	"STALE_STATE_REVISION",
	"STALE_TRANSCRIPT_REVISION",
	"TRANSCRIPT_CURSOR_INVALID",
	"TRANSCRIPT_CURSOR_EXPIRED",
	"REQUEST_CANCELLED",
	"REQUEST_DEADLINE_EXCEEDED",
	"REQUEST_CAPACITY_EXCEEDED",
]);

/** These errors are explicit retry/cancellation protocol outcomes, not server failures. */
export function isExpectedRequestControlFlow(error: LingErrorDto): boolean {
	return EXPECTED_CONTROL_FLOW_CODES.has(error.code);
}

export function normalizeRequestError(error: unknown, options: NormalizeRequestErrorOptions): LingErrorDto {
	const causeId = options.causeId ?? (isLingError(error) ? error.lingError.causeId : undefined) ?? randomUUID();
	if (isLingError(error)) return { ...error.lingError, causeId };
	if (error instanceof ZodError) return { ...validationError(error), causeId };
	const knownError = knownRequestError(errorCode(error) ?? "");
	if (knownError) return { ...knownError, causeId };
	return {
		code: options.fallbackCode ?? "INTERNAL_ERROR",
		category: "runtime",
		message: options.fallbackMessage,
		retryable: false,
		userAction: "report",
		causeId,
	};
}
