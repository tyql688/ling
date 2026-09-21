import { z } from "zod";
import { portableAbsolutePathSchema } from "./path-validation";
import { SESSION_ID_MAX_CHARS } from "./path-bounds";
import { safeIdSchema } from "./schema-primitives";

export const sessionRefSchema = z.strictObject({
	cwd: portableAbsolutePathSchema("Project path"),
	sessionId: safeIdSchema(SESSION_ID_MAX_CHARS, "Session id"),
});
export type SessionRef = z.infer<typeof sessionRefSchema>;

export function sessionKey(ref: SessionRef): string {
	return `${ref.cwd}\0${ref.sessionId}`;
}

/** Inverse of {@link sessionKey}; null for anything that is not a well-formed key. */
export function parseSessionKey(key: string): SessionRef | null {
	const separator = key.indexOf("\0");
	if (separator <= 0) return null;
	const cwd = key.slice(0, separator);
	const sessionId = key.slice(separator + 1);
	return sessionId.length === 0 ? null : { cwd, sessionId };
}

export function toSessionRef(summary: Pick<SessionRef, "cwd" | "sessionId">): SessionRef;
export function toSessionRef(summary: { cwd: string; id: string }): SessionRef;
export function toSessionRef(summary: Pick<SessionRef, "cwd" | "sessionId"> | { cwd: string; id: string }): SessionRef {
	return "sessionId" in summary
		? { cwd: summary.cwd, sessionId: summary.sessionId }
		: { cwd: summary.cwd, sessionId: summary.id };
}

export function sameSessionRef(a: SessionRef | null, b: SessionRef | null): boolean {
	return a !== null && b !== null && sessionKey(a) === sessionKey(b);
}

/** Keep first-seen identity order and the last supplied value, without cloning retained bindings. */
export function uniqueSessionRefs<Ref extends SessionRef>(refs: readonly Ref[]): Ref[] {
	const unique = new Map<string, Ref>();
	for (const ref of refs) unique.set(sessionKey(ref), ref);
	return [...unique.values()];
}
