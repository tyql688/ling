/** Narrows unknown boundary data to a non-array object without assuming its fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Nullable form for parsers that inspect individual fields. */
export function record(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}
