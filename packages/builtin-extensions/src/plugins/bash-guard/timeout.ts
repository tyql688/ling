/** Two minutes lets ordinary commands finish while bounding an omitted foreground timeout. */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/** One hour is Ling's foreground limit; longer work needs an explicitly managed background process. */
export const MAX_TIMEOUT_SECONDS = 60 * 60;

/**
 * Applied when the model omits `timeout`, and checked when it supplies one.
 *
 * Values at or below the ceiling pass through untouched — including 0, negatives and
 * NaN, which are Pi's own contract to reject. Duplicating that check here would only
 * produce a second, competing error message for the same input.
 */
export function resolveBashTimeoutSeconds(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_TIMEOUT_SECONDS;
	if (Number.isFinite(requested) && requested > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`bash timeout ${requested} is out of range (max ${MAX_TIMEOUT_SECONDS}). ` +
				"This parameter is in SECONDS, not milliseconds. " +
				"If the command does not exit on its own — a server, a watcher, a log tail — it does not belong in the " +
				"foreground at all: start it as a background process and read its output in a later call.",
		);
	}
	return requested;
}
