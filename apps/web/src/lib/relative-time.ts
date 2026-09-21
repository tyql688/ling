import type { UiLanguage } from "@ling/contracts/application";

const NOW: Record<UiLanguage, string> = { en: "now", "zh-CN": "刚刚", ja: "たった今", ko: "방금" };
let locale: UiLanguage = "en";
let formatter = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "narrow" });
let dateTimeFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
let clockFormatter = new Intl.DateTimeFormat("en", {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

/** Keeps relative timestamps in step with the UI language. */
export function setRelativeTimeLocale(language: UiLanguage): void {
	locale = language;
	formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
	dateTimeFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
	clockFormatter = new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

export function formatAbsoluteTime(epochMs: number): string {
	return dateTimeFormatter.format(new Date(epochMs));
}

/** Time of day with seconds, for dense log rows where the date sits in the tooltip. */
export function formatClockTime(epochMs: number): string {
	return clockFormatter.format(new Date(epochMs));
}

function compact(value: number, unit: Intl.RelativeTimeFormatUnit): string {
	return formatter.format(-value, unit).replace(/ ago$/u, "").replace(/前$/u, "");
}

/** Coarse relative time for dense session/history rows. */
export function relativeTime(epochMs: number, now = Date.now()): string {
	const seconds = Math.abs(now - epochMs) / 1_000;
	const roundedSeconds = Math.round(seconds);
	if (roundedSeconds <= 44) return NOW[locale];
	if (roundedSeconds <= 89) return compact(1, "minute");

	const minutes = Math.round(seconds / 60);
	if (minutes <= 44) return compact(minutes, "minute");
	if (minutes <= 89) return compact(1, "hour");

	const hours = Math.round(seconds / 3_600);
	if (hours <= 21) return compact(hours, "hour");
	if (hours <= 35) return compact(1, "day");

	const days = Math.round(seconds / 86_400);
	if (days <= 25) return compact(days, "day");
	if (days <= 45) return compact(1, "month");

	const months = Math.round(days / 30.4375);
	if (months <= 10) return compact(Math.max(2, months), "month");
	if (months <= 17) return compact(1, "year");
	return compact(Math.max(2, Math.round(days / 365.25)), "year");
}
