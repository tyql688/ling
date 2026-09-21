import type { ProviderQuota, ProviderQuotaSnapshot } from "@ling/contracts/usage";
import { throwIfOperationAborted, toError, waitForOperation } from "@ling/core/ling-error";
import type { PiModelRuntimes } from "./model-runtime";
import { fetchClaudeQuota } from "./provider-quotas/anthropic";
import { fetchDeepSeekQuota } from "./provider-quotas/deepseek";
import { fetchCopilotQuota } from "./provider-quotas/github-copilot";
import { fetchKimiQuota } from "./provider-quotas/kimi";
import { fetchMiniMaxQuota } from "./provider-quotas/minimax";
import { fetchCodexQuota } from "./provider-quotas/openai-codex";
import { fetchOpenCodeGoQuota } from "./provider-quotas/opencode-go";
import { fetchOpenRouterQuota } from "./provider-quotas/openrouter";
import {
	canonicalQuotaProvider,
	createProviderQuotaCache,
	providerQuotaResult,
	quotaErrorCode,
	UnsupportedProviderQuotaError,
	type ProviderQuotaData,
	type QuotaRuntime,
	type RuntimeProvider,
} from "./provider-quotas/shared";
import { fetchXaiQuota } from "./provider-quotas/xai";
import { fetchZaiQuota } from "./provider-quotas/zai";

interface QuotaAdapter {
	baseUrls: readonly string[];
	urlSource: "provider" | "models";
	auth: "oauth" | "token";
	read(runtime: QuotaRuntime, signal: AbortSignal): Promise<ProviderQuotaData>;
}

export function createPiProviderQuotas(
	modelRuntimes: Pick<PiModelRuntimes, "getGlobalModelRuntime" | "readStoredProfileCredential">,
) {
	const cache = createProviderQuotaCache();
	const lifetime = new AbortController();
	const pending = new Set<Promise<ProviderQuota>>();
	let disposal: Promise<void> | null = null;
	const adapters = new Map<string, QuotaAdapter>([
		[
			"openai-codex",
			{ baseUrls: ["https://chatgpt.com/backend-api"], urlSource: "provider", auth: "oauth", read: fetchCodexQuota },
		],
		[
			"anthropic",
			{
				baseUrls: ["https://api.anthropic.com"],
				urlSource: "provider",
				auth: "oauth",
				read: (runtime, signal) => fetchClaudeQuota(runtime, signal, cache),
			},
		],
		[
			"github-copilot",
			{
				baseUrls: ["https://api.individual.githubcopilot.com"],
				urlSource: "provider",
				auth: "oauth",
				read: (runtime, signal) => fetchCopilotQuota(runtime, signal, modelRuntimes.readStoredProfileCredential),
			},
		],
		[
			"openrouter",
			{ baseUrls: ["https://openrouter.ai/api/v1"], urlSource: "provider", auth: "token", read: fetchOpenRouterQuota },
		],
		[
			"kimi-coding",
			{ baseUrls: ["https://api.kimi.com/coding"], urlSource: "provider", auth: "token", read: fetchKimiQuota },
		],
		[
			"deepseek",
			{ baseUrls: ["https://api.deepseek.com"], urlSource: "provider", auth: "token", read: fetchDeepSeekQuota },
		],
		[
			"minimax",
			{
				baseUrls: ["https://api.minimax.io/anthropic"],
				urlSource: "provider",
				auth: "token",
				read: (runtime, signal) => fetchMiniMaxQuota(runtime, "minimax", signal),
			},
		],
		[
			"minimax-cn",
			{
				baseUrls: ["https://api.minimaxi.com/anthropic"],
				urlSource: "provider",
				auth: "token",
				read: (runtime, signal) => fetchMiniMaxQuota(runtime, "minimax-cn", signal),
			},
		],
		[
			"opencode-go",
			{
				baseUrls: ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1"],
				urlSource: "models",
				auth: "token",
				read: fetchOpenCodeGoQuota,
			},
		],
		["xai", { baseUrls: ["https://api.x.ai/v1"], urlSource: "provider", auth: "oauth", read: fetchXaiQuota }],
		[
			"zai",
			{
				baseUrls: ["https://api.z.ai/api/coding/paas/v4"],
				urlSource: "provider",
				auth: "token",
				read: (runtime, signal) => fetchZaiQuota(runtime, "zai", signal),
			},
		],
		[
			"zai-coding-cn",
			{
				baseUrls: ["https://open.bigmodel.cn/api/coding/paas/v4"],
				urlSource: "provider",
				auth: "token",
				read: (runtime, signal) => fetchZaiQuota(runtime, "zai-coding-cn", signal),
			},
		],
	]);

	async function readProviderQuota(
		runtime: QuotaRuntime,
		provider: RuntimeProvider,
		signal: AbortSignal,
	): Promise<ProviderQuota> {
		throwIfOperationAborted(signal);
		const adapter = adapters.get(provider.id);
		if (
			!adapter ||
			!canonicalQuotaProvider(runtime, provider, adapter.baseUrls, adapter.urlSource) ||
			(adapter.auth === "oauth" && !runtime.isUsingOAuth(provider.id))
		)
			return providerQuotaResult(provider, { status: "unsupported" });
		try {
			const data = await adapter.read(runtime, signal);
			throwIfOperationAborted(signal);
			return providerQuotaResult(provider, { status: "available", data });
		} catch (cause) {
			throwIfOperationAborted(signal);
			return providerQuotaResult(
				provider,
				toError(cause) instanceof UnsupportedProviderQuotaError
					? { status: "unsupported" }
					: { status: "error", error: quotaErrorCode(cause) },
			);
		}
	}

	function providerQuota(
		runtime: QuotaRuntime,
		provider: RuntimeProvider,
		signal: AbortSignal,
	): Promise<ProviderQuota> {
		const request = readProviderQuota(runtime, provider, AbortSignal.any([signal, lifetime.signal]));
		pending.add(request);
		void request.then(
			() => pending.delete(request),
			() => pending.delete(request),
		);
		return request;
	}

	async function getProviderQuotaSnapshot(signal: AbortSignal): Promise<ProviderQuotaSnapshot> {
		const activeSignal = AbortSignal.any([signal, lifetime.signal]);
		throwIfOperationAborted(activeSignal);
		const runtime = await waitForOperation(modelRuntimes.getGlobalModelRuntime(), activeSignal);
		throwIfOperationAborted(activeSignal);
		const providers = runtime
			.getProviders()
			.filter((provider) => runtime.getProviderAuthStatus(provider.id).configured)
			.toSorted((left, right) => left.name.localeCompare(right.name, "en"));
		const quotas = await waitForOperation(
			Promise.all(providers.map((provider) => providerQuota(runtime, provider, activeSignal))),
			activeSignal,
		);
		return { generatedAt: Date.now(), providers: quotas };
	}
	return {
		providerQuota,
		getProviderQuotaSnapshot,
		dispose(): Promise<void> {
			if (disposal) return disposal;
			lifetime.abort();
			disposal = Promise.all([cache.dispose(), Promise.allSettled([...pending])]).then(() => undefined);
			return disposal;
		},
	};
}

export type PiProviderQuotas = ReturnType<typeof createPiProviderQuotas>;
