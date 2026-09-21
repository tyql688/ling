import { SESSION_ID_MAX_CHARS } from "@ling/contracts/path-bounds";
import { isRecord } from "@ling/contracts/records";
import { safeIdSchema } from "@ling/contracts/schema-primitives";
import { z } from "zod";

export const MANUAL_FORK_ENTRY_TYPE = "ling:manual-fork";
// Version 1 binds provenance to this session, so copied parent entries cannot confer it on a child.
const manualForkEntrySchema = z.strictObject({
	version: z.literal(1),
	sessionId: safeIdSchema(SESSION_ID_MAX_CHARS, "Manual fork session id"),
});

interface OriginHeader {
	id: string;
	timestamp: unknown;
	parentSession?: unknown;
}

/** Reads immutable origin metadata without retaining transcript bodies during discovery. */
export function createSessionOriginReader(header: OriginHeader | null | undefined) {
	let recorded = false;
	let inheritedMarker = false;
	let legacyFork = false;
	const createdAt = typeof header?.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
	return {
		read(entry: unknown): void {
			if (!isRecord(entry)) return;
			if (entry.type === "custom" && entry.customType === MANUAL_FORK_ENTRY_TYPE) {
				const marker = manualForkEntrySchema.parse(entry.data);
				if (marker.sessionId === header?.id) recorded = true;
				else inheritedMarker = true;
			}
			if (entry.type !== "session_info") return;
			const forkTitle = typeof entry.name === "string" && /\(fork\)\s*$/i.test(entry.name.trim());
			const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
			// Legacy Ling wrote its initial name immediately after the fork header, often
			// in the same millisecond. Earlier parent names cannot establish this origin.
			if (timestamp >= createdAt && forkTitle) legacyFork = true;
		},
		result() {
			const hasParent = typeof header?.parentSession === "string" && header.parentSession.length > 0;
			return {
				recorded,
				manualFork: hasParent && (recorded || (!inheritedMarker && legacyFork)),
			};
		},
	};
}

export function readSessionOrigin(header: OriginHeader | null | undefined, entries: readonly unknown[]) {
	const reader = createSessionOriginReader(header);
	for (const entry of entries) reader.read(entry);
	return reader.result();
}

/** Uses Pi's custom-entry format; metadata is excluded from the model's conversation. */
export function recordManualForkOrigin(manager: {
	getSessionId(): string;
	appendCustomEntry(customType: string, data: unknown): string;
}): void {
	manager.appendCustomEntry(MANUAL_FORK_ENTRY_TYPE, { version: 1, sessionId: manager.getSessionId() });
}
