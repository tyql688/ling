import { record as asRecord } from "@ling/contracts/records";
import type { ProviderQuotaWindow } from "@ling/contracts/usage";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
	boundedText,
	emptyWindow,
	epochMilliseconds,
	flexibleNumberSchema,
	nonnegativeNumberSchema,
	numericValue,
	parsePayload,
	PROVIDER_QUOTA_WINDOW_MAX_ITEMS,
	ProviderQuotaReadError,
	requestJson,
	resolveProviderToken,
	textSchema,
	type ProviderQuotaData,
	type QuotaRuntime,
} from "./shared";

/** JWT payloads are metadata only; this bound rejects malformed credentials before decoding them. */
const JWT_PAYLOAD_MAX_CHARS = 16_384;

const codexWindowSchema = z.object({
	used_percent: nonnegativeNumberSchema,
	limit_window_seconds: nonnegativeNumberSchema.nullish(),
	reset_at: nonnegativeNumberSchema.nullish(),
});
const codexRateLimitSchema = z.object({
	primary_window: codexWindowSchema.nullish(),
	secondary_window: codexWindowSchema.nullish(),
});
const codexUsageSchema = z.object({
	plan_type: textSchema.nullish(),
	rate_limit: codexRateLimitSchema.nullish(),
	credits: z
		.object({
			has_credits: z.boolean().optional(),
			unlimited: z.boolean().optional(),
			balance: flexibleNumberSchema.nullish(),
		})
		.nullish(),
	additional_rate_limits: z
		.array(
			z.object({
				metered_feature: textSchema.optional(),
				limit_name: textSchema.optional(),
				rate_limit: codexRateLimitSchema.nullish(),
			}),
		)
		.max(PROVIDER_QUOTA_WINDOW_MAX_ITEMS)
		.nullish(),
});

type CodexRateLimit = z.infer<typeof codexRateLimitSchema>;
type CodexWindow = z.infer<typeof codexWindowSchema>;

function codexWindow(
	id: string,
	window: CodexWindow,
	label: string | null,
	kind: ProviderQuotaWindow["kind"],
): ProviderQuotaWindow {
	return emptyWindow(id, kind, {
		label,
		usedPercent: window.used_percent,
		durationSeconds:
			window.limit_window_seconds && window.limit_window_seconds > 0 ? window.limit_window_seconds : null,
		resetAt: epochMilliseconds(window.reset_at),
	});
}

function appendCodexWindows(
	windows: ProviderQuotaWindow[],
	rateLimit: CodexRateLimit | null | undefined,
	prefix: string,
	label: string | null,
	kind: ProviderQuotaWindow["kind"],
): void {
	if (rateLimit?.primary_window) windows.push(codexWindow(`${prefix}:primary`, rateLimit.primary_window, label, kind));
	if (rateLimit?.secondary_window)
		windows.push(codexWindow(`${prefix}:secondary`, rateLimit.secondary_window, label, kind));
}

function codexAccountId(token: string): string {
	const payloadPart = token.split(".")[1];
	if (!payloadPart || payloadPart.length > JWT_PAYLOAD_MAX_CHARS) throw new ProviderQuotaReadError("authentication");
	try {
		const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
		const claims = asRecord(asRecord(payload)?.["https://api.openai.com/auth"]);
		const accountId = boundedText(claims?.chatgpt_account_id);
		if (accountId) return accountId;
	} catch (cause) {
		throw new ProviderQuotaReadError("authentication", cause);
	}
	throw new ProviderQuotaReadError("authentication");
}

export async function fetchCodexQuota(runtime: QuotaRuntime, signal: AbortSignal): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, "openai-codex", signal);
	return parseCodexQuota(
		await requestJson(
			"https://chatgpt.com/backend-api/wham/usage",
			{
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"ChatGPT-Account-Id": codexAccountId(token),
				originator: "pi",
			},
			signal,
		),
	);
}

export function parseCodexQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(codexUsageSchema, value);
	const windows: ProviderQuotaWindow[] = [];
	appendCodexWindows(windows, payload.rate_limit, "codex", null, "rolling");
	for (const [index, additional] of (payload.additional_rate_limits ?? []).entries()) {
		const feature = additional.metered_feature ?? `additional-${index + 1}`;
		appendCodexWindows(
			windows,
			additional.rate_limit,
			feature,
			additional.limit_name ?? additional.metered_feature ?? null,
			"model",
		);
	}
	const balance =
		payload.credits?.has_credits === false || payload.credits?.unlimited === true
			? null
			: numericValue(payload.credits?.balance);
	return {
		plan: payload.plan_type ?? null,
		windows,
		amounts: balance === null ? [] : [{ kind: "balance", period: null, value: balance, limit: null, unit: "credits" }],
	};
}
