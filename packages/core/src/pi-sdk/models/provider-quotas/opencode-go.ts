import {
	type QuotaRuntime,
	dateSchema,
	emptyWindow,
	epochMilliseconds,
	nonnegativeNumberSchema,
	parsePayload,
	requestJson,
	resolveProviderToken,
	SECONDS_PER_HOUR,
	SECONDS_PER_WEEK,
	textSchema,
	type ProviderQuotaData,
} from "./shared";
import type { ProviderQuotaWindow, ProviderQuotaWindowKind } from "@ling/contracts/usage";
import { z } from "zod";

const openCodeWindowSchema = z.object({
	percent: nonnegativeNumberSchema,
	resetsAt: dateSchema.nullish(),
});
const openCodeUsageSchema = z.object({
	plan: textSchema.nullish(),
	usage: z.object({
		plan: textSchema.nullish(),
		rolling: openCodeWindowSchema,
		weekly: openCodeWindowSchema.nullish(),
		monthly: openCodeWindowSchema.nullish(),
	}),
});

type OpenCodeWindow = z.infer<typeof openCodeWindowSchema>;

function openCodeWindow(
	id: string,
	kind: ProviderQuotaWindowKind,
	window: OpenCodeWindow,
	durationSeconds: number | null,
	label: string | null = null,
): ProviderQuotaWindow {
	return emptyWindow(id, kind, {
		label,
		usedPercent: window.percent,
		durationSeconds,
		resetAt: epochMilliseconds(window.resetsAt),
	});
}

export async function fetchOpenCodeGoQuota(runtime: QuotaRuntime, signal: AbortSignal): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, "opencode-go", signal);
	return parseOpenCodeGoQuota(
		await requestJson(
			"https://opencode.ai/zen/go/v1/usage",
			{ Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": "pi" },
			signal,
		),
	);
}

export function parseOpenCodeGoQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(openCodeUsageSchema, value);
	const windows = [openCodeWindow("rolling", "rolling", payload.usage.rolling, 5 * SECONDS_PER_HOUR)];
	if (payload.usage.weekly) {
		windows.push(openCodeWindow("weekly", "weekly", payload.usage.weekly, SECONDS_PER_WEEK));
	}
	if (payload.usage.monthly) {
		windows.push(openCodeWindow("monthly", "other", payload.usage.monthly, null, "Monthly"));
	}
	return { plan: payload.usage.plan ?? payload.plan ?? null, windows, amounts: [] };
}
