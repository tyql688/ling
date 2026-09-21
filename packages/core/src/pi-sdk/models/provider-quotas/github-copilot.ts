import {
	type QuotaRuntime,
	boundedText,
	dateSchema,
	emptyWindow,
	epochMilliseconds,
	flexibleNumberSchema,
	parsePayload,
	PROVIDER_QUOTA_WINDOW_MAX_ITEMS,
	ProviderQuotaReadError,
	requestJson,
	resolveProviderAuth,
	textSchema,
	UnsupportedProviderQuotaError,
	type ProviderQuotaData,
} from "./shared";
import type { ProviderQuotaAmount, ProviderQuotaWindow, ProviderQuotaWindowKind } from "@ling/contracts/usage";
import { waitForOperation } from "@ling/core/ling-error";
import { z } from "zod";
import type { PiModelRuntimes } from "../model-runtime";

const copilotQuotaSchema = z.object({
	entitlement: flexibleNumberSchema.pipe(z.number().nonnegative()).nullish(),
	remaining: flexibleNumberSchema.pipe(z.number().nonnegative()).nullish(),
	credits_used: flexibleNumberSchema.pipe(z.number().nonnegative()).nullish(),
	percent_remaining: flexibleNumberSchema.nullish(),
	quota_id: textSchema.nullish(),
	unlimited: z.boolean().optional(),
});
const copilotUsageSchema = z.object({
	copilot_plan: textSchema.nullish(),
	quota_reset_date: dateSchema.nullish(),
	quota_snapshots: z
		.record(textSchema, copilotQuotaSchema)
		.refine((value) => Object.keys(value).length <= PROVIDER_QUOTA_WINDOW_MAX_ITEMS)
		.nullish(),
});

/** Only Pi's Copilot client identity headers belong on the separate GitHub account endpoint. */
const COPILOT_ACCOUNT_HEADER_NAMES = new Set([
	"user-agent",
	"editor-version",
	"editor-plugin-version",
	"copilot-integration-id",
]);

function normalizeGitHubDomain(value: unknown): string | null {
	const domain = boundedText(value);
	if (!domain) return null;
	try {
		return new URL(domain.includes("://") ? domain : `https://${domain}`).hostname || null;
	} catch {
		return null;
	}
}

function copilotWindowKind(name: string): ProviderQuotaWindowKind {
	if (name === "premium_interactions" || name === "premium_models") return "premium";
	if (name === "chat") return "chat";
	return "other";
}

export async function fetchCopilotQuota(
	runtime: QuotaRuntime,
	signal: AbortSignal,
	readStoredProfileCredential: PiModelRuntimes["readStoredProfileCredential"],
): Promise<ProviderQuotaData> {
	await resolveProviderAuth(runtime, "github-copilot", signal);
	const credential = await waitForOperation(readStoredProfileCredential("github-copilot"), signal);
	if (credential?.type !== "oauth" || !credential.refresh) throw new ProviderQuotaReadError("authentication");
	const enterpriseDomain = normalizeGitHubDomain(credential.enterpriseUrl);
	const enterpriseConfigured =
		credential.enterpriseUrl !== undefined && credential.enterpriseUrl !== null && credential.enterpriseUrl !== "";
	if ((enterpriseConfigured && !enterpriseDomain) || (enterpriseDomain && enterpriseDomain !== "github.com")) {
		throw new UnsupportedProviderQuotaError();
	}
	const providerHeaders = Object.fromEntries(
		Object.entries(runtime.getModels("github-copilot")[0]?.headers ?? {}).filter(
			([name, value]) => COPILOT_ACCOUNT_HEADER_NAMES.has(name.toLowerCase()) && typeof value === "string",
		),
	);
	return parseCopilotQuota(
		await requestJson(
			"https://api.github.com/copilot_internal/user",
			{ ...providerHeaders, Accept: "application/json", Authorization: `token ${credential.refresh}` },
			signal,
		),
	);
}

export function parseCopilotQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(copilotUsageSchema, value);
	const resetAt = epochMilliseconds(payload.quota_reset_date);
	const windows: ProviderQuotaWindow[] = [];
	const amounts: ProviderQuotaAmount[] = [];
	for (const [name, quota] of Object.entries(payload.quota_snapshots ?? {})) {
		const limit = quota.entitlement ?? null;
		const remaining = quota.remaining ?? null;
		if (amounts.length === 0 && quota.credits_used !== null && quota.credits_used !== undefined) {
			amounts.push({ kind: "spend", period: null, value: quota.credits_used, limit: null, unit: "credits" });
		}
		if (quota.unlimited !== true && limit === 0 && remaining === 0) continue;
		const used = limit !== null && remaining !== null ? limit - remaining : null;
		const usedPercent =
			quota.unlimited === true
				? null
				: quota.percent_remaining !== null && quota.percent_remaining !== undefined
					? Math.max(0, 100 - quota.percent_remaining)
					: limit !== null && limit > 0 && remaining !== null
						? Math.max(0, ((limit - remaining) / limit) * 100)
						: null;
		if (usedPercent === null && quota.unlimited !== true && limit === null && remaining === null) continue;
		const kind = copilotWindowKind(name);
		windows.push(
			emptyWindow(name, kind, {
				label: kind === "other" ? name : null,
				usedPercent,
				used,
				limit,
				remaining,
				unit: kind === "premium" ? "interactions" : "requests",
				resetAt,
				unlimited: quota.unlimited === true,
			}),
		);
	}
	return { plan: payload.copilot_plan ?? null, windows, amounts };
}
