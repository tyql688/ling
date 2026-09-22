import type { ProviderQuotaAmount, ProviderQuotaErrorCode, ProviderQuotaWindow } from "@ling/contracts/usage";
import { STATUS_PRESENTATION } from "@renderer/components/ui/status-presentation";
import type { TFunction } from "i18next";

/** At 70% used, quota bars turn orange to flag shrinking headroom. */
export const PROVIDER_QUOTA_WARNING_USED_PERCENT = 70;
/** At 90% used, quota bars turn red to flag imminent exhaustion. */
const PROVIDER_QUOTA_DANGER_USED_PERCENT = 90;
/** Duration formatting uses exact provider seconds rather than assuming fixed quota windows. */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;

function formatCount(value: number, language: string): string {
	return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
}

export function humanize(value: string): string {
	const text = value.replaceAll(/[_-]+/gu, " ").trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

function formatDuration(seconds: number, t: TFunction): string {
	if (seconds % SECONDS_PER_WEEK === 0) return t("usage.providerQuotaWeeks", { count: seconds / SECONDS_PER_WEEK });
	if (seconds % SECONDS_PER_DAY === 0) return t("usage.providerQuotaDays", { count: seconds / SECONDS_PER_DAY });
	if (seconds % SECONDS_PER_HOUR === 0) return t("usage.providerQuotaHours", { count: seconds / SECONDS_PER_HOUR });
	if (seconds % SECONDS_PER_MINUTE === 0)
		return t("usage.providerQuotaMinutes", { count: seconds / SECONDS_PER_MINUTE });
	return t("usage.providerQuotaSeconds", { count: seconds });
}

export function quotaWindowTitle(window: ProviderQuotaWindow, t: TFunction): string {
	const duration = window.durationSeconds === null ? null : formatDuration(window.durationSeconds, t);
	const label = window.label
		? humanize(window.label)
		: window.kind === "model"
			? t("usage.providerQuotaModelLimit")
			: null;
	if (label) return duration ? `${label} · ${duration}` : label;
	if (duration) return duration;
	switch (window.kind) {
		case "weekly":
			return t("usage.providerQuotaWeekly");
		case "premium":
			return t("usage.providerQuotaPremium");
		case "chat":
			return t("usage.providerQuotaChat");
		default:
			return t("usage.providerQuotaLimit");
	}
}

export function quotaUsedProgressPercent(window: ProviderQuotaWindow): number | null {
	if (window.unlimited || window.usedPercent === null) return null;
	return Math.max(0, Math.min(100, window.usedPercent));
}

export function quotaProgressColorClass(usedPercent: number): string {
	if (usedPercent >= PROVIDER_QUOTA_DANGER_USED_PERCENT) return STATUS_PRESENTATION.error.fill;
	if (usedPercent >= PROVIDER_QUOTA_WARNING_USED_PERCENT) return STATUS_PRESENTATION.attention.fill;
	return STATUS_PRESENTATION.success.fill;
}

export function quotaPercent(window: ProviderQuotaWindow, t: TFunction): string | null {
	if (window.unlimited) return t("usage.providerQuotaUnlimited");
	if (window.usedPercent === null) return null;
	const percent = Math.round(window.usedPercent * 10) / 10;
	return t("usage.providerQuotaUsedPercent", { percent });
}

export function quotaCount(window: ProviderQuotaWindow, language: string, t: TFunction) {
	const unit =
		window.unit === "requests"
			? t("usage.providerQuotaRequests")
			: window.unit === "interactions"
				? t("usage.providerQuotaInteractions")
				: "";
	if (window.used !== null && window.limit !== null) {
		return t(unit ? "usage.providerQuotaCountUsedUnit" : "usage.providerQuotaCountUsed", {
			used: formatCount(window.used, language),
			limit: formatCount(window.limit, language),
			unit,
		});
	}
	if (window.remaining !== null && window.limit !== null) {
		return t(unit ? "usage.providerQuotaCountRemainingUnit" : "usage.providerQuotaCountRemaining", {
			remaining: formatCount(window.remaining, language),
			limit: formatCount(window.limit, language),
			unit,
		});
	}
	return null;
}

export function formatAmount(amount: ProviderQuotaAmount, language: string, t: TFunction) {
	const format = (value: number) =>
		amount.unit === "credits"
			? t("usage.providerQuotaCreditsValue", { value: formatCount(value, language) })
			: new Intl.NumberFormat(language, { style: "currency", currency: amount.unit }).format(value);
	return amount.limit === null ? format(amount.value) : `${format(amount.value)} / ${format(amount.limit)}`;
}

export function amountLabel(amount: ProviderQuotaAmount, t: TFunction): string {
	if (amount.kind === "balance") return t("usage.providerQuotaBalance");
	if (amount.kind === "remaining") return t("usage.providerQuotaAllowanceRemaining");
	if (amount.unit === "credits") return t("usage.providerQuotaCreditsUsed");
	switch (amount.period) {
		case "day":
			return t("usage.providerQuotaSpendDay");
		case "week":
			return t("usage.providerQuotaSpendWeek");
		case "month":
			return t("usage.providerQuotaSpendMonth");
		case "total":
			return t("usage.providerQuotaSpendTotal");
		default:
			return t("usage.providerQuotaSpend");
	}
}

export function providerError(error: ProviderQuotaErrorCode | null, t: TFunction): string {
	switch (error) {
		case "authentication":
			return t("usage.providerQuotaErrorAuthentication");
		case "rate-limit":
			return t("usage.providerQuotaErrorRateLimit");
		case "timeout":
			return t("usage.providerQuotaErrorTimeout");
		case "network":
			return t("usage.providerQuotaErrorNetwork");
		case "invalid-response":
			return t("usage.providerQuotaErrorResponse");
		default:
			return t("usage.providerQuotaErrorService");
	}
}
