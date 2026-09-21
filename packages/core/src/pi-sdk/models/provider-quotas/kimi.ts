import { record as asRecord } from "@ling/contracts/records";
import type { ProviderQuotaAmount, ProviderQuotaWindow, ProviderQuotaWindowKind } from "@ling/contracts/usage";
import { z } from "zod";
import {
	boundedText,
	currencyCode,
	emptyWindow,
	epochMilliseconds,
	MINOR_UNITS_PER_CURRENCY_UNIT,
	nonnegativeValue,
	parsePayload,
	PROVIDER_QUOTA_DATE_MAX_CHARS,
	PROVIDER_QUOTA_WINDOW_MAX_ITEMS,
	requestJson,
	resolveProviderToken,
	SECONDS_PER_DAY,
	SECONDS_PER_HOUR,
	SECONDS_PER_MINUTE,
	SECONDS_PER_WEEK,
	type ProviderQuotaData,
	type QuotaRuntime,
} from "./shared";

/** Kimi encodes booster-wallet balances as fixed-point millionths of one cent. */
const KIMI_FIXED_POINT_CENTS = 1_000_000n;

const kimiUsageSchema = z.object({
	usage: z.unknown().optional(),
	limits: z.array(z.unknown()).max(PROVIDER_QUOTA_WINDOW_MAX_ITEMS).optional(),
	boosterWallet: z.unknown().optional(),
	user: z.unknown().optional(),
});

function kimiResetAt(record: Record<string, unknown>): number | null {
	for (const key of [
		"resetTime",
		"reset_time",
		"resetAt",
		"reset_at",
		"resetsAt",
		"resets_at",
		"nextResetTime",
		"next_reset_time",
	]) {
		const value = record[key];
		if (typeof value === "string" || typeof value === "number") {
			const timestamp = epochMilliseconds(value);
			if (timestamp !== null) return timestamp;
		}
	}
	return null;
}

function kimiDurationSeconds(value: unknown): number | null {
	const window = asRecord(value);
	const duration = nonnegativeValue(window?.duration);
	const unit = boundedText(window?.timeUnit ?? window?.time_unit)?.toUpperCase();
	if (!duration || !unit) return null;
	const multiplier = unit.includes("MINUTE")
		? SECONDS_PER_MINUTE
		: unit.includes("HOUR")
			? SECONDS_PER_HOUR
			: unit.includes("DAY")
				? SECONDS_PER_DAY
				: unit.includes("WEEK")
					? SECONDS_PER_WEEK
					: null;
	if (multiplier === null) return null;
	const seconds = duration * multiplier;
	return Number.isFinite(seconds) ? seconds : null;
}

function kimiWindow(
	id: string,
	kind: ProviderQuotaWindowKind,
	value: unknown,
	container: Record<string, unknown> | null,
): ProviderQuotaWindow | null {
	const record = asRecord(value);
	if (!record) return null;
	const limit = nonnegativeValue(record.limit);
	let used = nonnegativeValue(record.used);
	let remaining = nonnegativeValue(record.remaining);
	if (used === null && limit !== null && remaining !== null) used = limit - remaining;
	if (remaining === null && limit !== null && used !== null) remaining = limit - used;
	if (limit === null && used === null && remaining === null) return null;
	const percent = limit !== null && limit > 0 && used !== null ? (used / limit) * 100 : null;
	return emptyWindow(id, kind, {
		label: boundedText(record.name ?? record.title ?? container?.name ?? container?.title),
		usedPercent: percent !== null && Number.isFinite(percent) ? Math.max(0, percent) : null,
		used,
		limit,
		remaining,
		unit: "requests",
		durationSeconds: kimiDurationSeconds(container?.window),
		resetAt: kimiResetAt(record) ?? (container ? kimiResetAt(container) : null),
	});
}

function bigintValue(value: unknown): bigint | null {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
	if (typeof value === "string" && value.length <= PROVIDER_QUOTA_DATE_MAX_CHARS && /^-?\d+$/u.test(value))
		return BigInt(value);
	return null;
}

function safeCurrencyAmountFromCents(cents: bigint): number | null {
	if (cents < 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	return Number(cents) / MINOR_UNITS_PER_CURRENCY_UNIT;
}

function kimiMoney(value: unknown): { amount: number; currency: string } | null {
	const record = asRecord(value);
	const cents = bigintValue(record?.priceInCents);
	const currency = currencyCode(record?.currency);
	if (cents === null || currency === null) return null;
	const amount = safeCurrencyAmountFromCents(cents);
	return amount === null ? null : { amount, currency };
}

function kimiAmounts(value: unknown): ProviderQuotaAmount[] {
	const wallet = asRecord(value);
	const balance = asRecord(wallet?.balance);
	if (!wallet || !balance || balance.type !== "BOOSTER") return [];
	const monthlyLimit = kimiMoney(wallet.monthlyChargeLimit);
	const monthlyUsed = kimiMoney(wallet.monthlyUsed);
	const currency =
		monthlyLimit && monthlyUsed && monthlyLimit.currency !== monthlyUsed.currency
			? null
			: (monthlyLimit?.currency ?? monthlyUsed?.currency ?? null);
	const amounts: ProviderQuotaAmount[] = [];
	if (monthlyUsed) {
		amounts.push({
			kind: "spend",
			period: "month",
			value: monthlyUsed.amount,
			limit: wallet.monthlyChargeLimitEnabled === true ? (monthlyLimit?.amount ?? null) : null,
			unit: monthlyUsed.currency,
		});
	}
	const fixedPointBalance = bigintValue(balance.amountLeft);
	if (fixedPointBalance !== null && currency) {
		const roundedCents =
			fixedPointBalance > 0n && fixedPointBalance < KIMI_FIXED_POINT_CENTS
				? 1n
				: (fixedPointBalance + KIMI_FIXED_POINT_CENTS / 2n) / KIMI_FIXED_POINT_CENTS;
		const amount = safeCurrencyAmountFromCents(roundedCents);
		if (amount !== null) amounts.push({ kind: "balance", period: null, value: amount, limit: null, unit: currency });
	}
	return amounts;
}

export async function fetchKimiQuota(runtime: QuotaRuntime, signal: AbortSignal): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, "kimi-coding", signal);
	return parseKimiQuota(
		await requestJson(
			"https://api.kimi.com/coding/v1/usages",
			{ Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": "pi" },
			signal,
		),
	);
}

export function parseKimiQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(kimiUsageSchema, value);
	const windows: ProviderQuotaWindow[] = [];
	const weekly = kimiWindow("weekly", "weekly", payload.usage, asRecord(payload.usage));
	if (weekly) windows.push(weekly);
	for (const [index, item] of (payload.limits ?? []).entries()) {
		const container = asRecord(item);
		const detail = container?.detail ?? item;
		const durationSeconds = kimiDurationSeconds(container?.window);
		const window = kimiWindow(`limit-${index + 1}`, durationSeconds ? "rolling" : "other", detail, container);
		if (window) windows.push(window);
	}
	const membership = asRecord(asRecord(payload.user)?.membership);
	return {
		plan: boundedText(membership?.level),
		windows,
		amounts: kimiAmounts(payload.boosterWallet),
	};
}
