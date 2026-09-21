import type { ProviderQuotaWindow } from "@ling/contracts/usage";

/** Account-wide windows precede model-specific allowances. Compare durations only within that scope. */
export function preferredQuotaWindow(windows: readonly ProviderQuotaWindow[]): ProviderQuotaWindow | null {
	const general = windows.filter((window) => window.kind !== "model");
	if (general.length > 0) windows = general;
	const [firstTimed, ...restTimed] = windows.filter((window) => window.durationSeconds !== null);
	if (firstTimed) {
		return restTimed.reduce(
			(shortest, window) =>
				(window.durationSeconds ?? Number.POSITIVE_INFINITY) < (shortest.durationSeconds ?? Number.POSITIVE_INFINITY)
					? window
					: shortest,
			firstTimed,
		);
	}
	let selected: ProviderQuotaWindow | null = null;
	for (const window of windows) {
		if (window.unlimited || window.usedPercent === null) continue;
		if (selected === null || window.usedPercent > (selected.usedPercent ?? Number.NEGATIVE_INFINITY)) {
			selected = window;
		}
	}
	return selected ?? windows.find((window) => window.unlimited) ?? null;
}
