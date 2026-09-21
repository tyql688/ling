import { SESSION_TITLE_MAX_CHARS } from "@ling/contracts/session";
import { createLingError } from "@ling/core/ling-error";

function invalidSessionInput(message: string): never {
	throw createLingError({ code: "INVALID_REQUEST", category: "validation", message, retryable: false });
}

export function assertBoundedSessionText(value: string, maxLength: number, label: string): void {
	if (value.length > maxLength) invalidSessionInput(`${label} exceeds ${maxLength} characters.`);
}

export function normalizeLingSessionTitle(title: string): string {
	assertBoundedSessionText(title, SESSION_TITLE_MAX_CHARS, "Session title");
	const trimmed = title.trim();
	if (!trimmed) invalidSessionInput("Session title must not be empty.");
	return trimmed;
}

export function deriveForkSessionTitle(originalTitle: string | undefined): string {
	const normalized = originalTitle?.trim();
	if (!normalized) return "Forked session";
	const suffix = " (fork)";
	return `${normalized.slice(0, SESSION_TITLE_MAX_CHARS - suffix.length).trimEnd()}${suffix}`;
}
