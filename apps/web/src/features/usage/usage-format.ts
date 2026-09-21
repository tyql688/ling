/** Share of a total as a percent label: <10% keeps one decimal (8.2%), otherwise integer (53%). */
export function formatShare(share: number): string {
	const percent = share * 100;
	if (percent > 0 && percent < 10) return `${(Math.round(percent * 10) / 10).toString()}%`;
	return `${Math.round(percent).toString()}%`;
}

export function formatUsageTime(timestamp: number, language: string, includeDate = false): string {
	return new Intl.DateTimeFormat(language, {
		...(includeDate ? { month: "short", day: "numeric" } : {}),
		hour: "2-digit",
		hourCycle: "h23",
		minute: "2-digit",
		second: "2-digit",
	}).format(timestamp);
}

export function formatUsageTimeRange(start: number, end: number, language: string): string {
	const includeDate = new Date(start).toDateString() !== new Date(end).toDateString();
	const startLabel = formatUsageTime(start, language, includeDate);
	if (start === end) return startLabel;
	return `${startLabel}–${formatUsageTime(end, language, includeDate)}`;
}

/** Short axis/tooltip label for a YYYY-MM-DD local date key, e.g. 7月3日 / Jul 3. */
export function formatDayLabel(dateKey: string, language: string): string {
	const [year, month, day] = dateKey.split("-").map(Number);
	if (!year || !month || !day) return dateKey;
	const date = new Date(year, month - 1, day);
	return date.toLocaleDateString(language, { month: "short", day: "numeric" });
}
