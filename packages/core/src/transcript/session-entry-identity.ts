interface PiSessionEntryIdentity {
	messageId: string;
	entryId: string;
	occurredAt: number;
}

type PiSessionEntryIdentityResult =
	{ status: "valid"; identity: PiSessionEntryIdentity } | { status: "invalid"; reason: "identity" | "timestamp" };

export function parsePiSessionEntryTimestamp(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const occurredAt = Date.parse(value);
	return Number.isFinite(occurredAt) && new Date(occurredAt).toISOString() === value ? occurredAt : null;
}

export function inspectPiSessionEntryIdentity(entry: {
	id: unknown;
	timestamp: unknown;
}): PiSessionEntryIdentityResult {
	if (typeof entry.id !== "string" || entry.id.length === 0) {
		return { status: "invalid", reason: "identity" };
	}
	const occurredAt = parsePiSessionEntryTimestamp(entry.timestamp);
	if (occurredAt === null) return { status: "invalid", reason: "timestamp" };
	return {
		status: "valid",
		identity: {
			messageId: `entry:${entry.id}`,
			entryId: entry.id,
			occurredAt,
		},
	};
}
