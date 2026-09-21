import { describe, expect, it, vi } from "vitest";
import { createPiProviderQuotas } from "./provider-quotas";
import type { QuotaRuntime } from "./provider-quotas/shared";

describe("quota admission", () => {
	it.each([
		["minimax", "https://api.minimax.io/anthropic", "https://api.minimax.io"],
		["minimax-cn", "https://api.minimaxi.com/anthropic", "https://api.minimaxi.com"],
		["zai", "https://api.z.ai/api/coding/paas/v4", "https://api.z.ai"],
		["zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4", "https://open.bigmodel.cn"],
	])("keeps regional endpoints and MiniMax fallback order for %s", async (id, baseUrl, host) => {
		const miniMax = id.startsWith("minimax");
		const fetch = vi.fn(async () =>
			Response.json(
				miniMax
					? { model_remains: [{ model_name: "general", current_interval_remaining_percent: 80 }] }
					: { code: 200, success: true, data: { limits: [] } },
			),
		);
		if (miniMax) fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", fetch);
		const runtime: QuotaRuntime = {
			getAuth: async () => ({ auth: { apiKey: "synthetic-key" } }),
			getModels: () => [],
			isUsingOAuth: () => false,
		};
		const owner = createPiProviderQuotas({
			getGlobalModelRuntime: async () => {
				throw new Error("not used");
			},
			readStoredProfileCredential: async () => undefined,
		});
		try {
			expect(await owner.providerQuota(runtime, { id, name: id, baseUrl }, new AbortController().signal)).toMatchObject(
				{ status: "available" },
			);
			const requests = fetch.mock.calls as unknown[][];
			expect(requests.map(([url]) => url)).toEqual(
				miniMax
					? [`${host}/v1/token_plan/remains`, `${host}/v1/api/openplatform/coding_plan/remains`]
					: [`${host}/api/monitor/usage/quota/limit`],
			);
		} finally {
			await owner.dispose();
		}
	});
	it.each([
		"openai-codex",
		"anthropic",
		"github-copilot",
		"openrouter",
		"kimi-coding",
		"deepseek",
		"minimax",
		"minimax-cn",
		"opencode-go",
		"xai",
		"zai",
		"zai-coding-cn",
		"custom",
		"constructor",
		"__proto__",
	])("rejects custom endpoints before resolving %s credentials", async (id) => {
		const getAuth = vi.fn(() => {
			throw new Error("Unexpected credential access");
		});
		const { providerQuota } = createPiProviderQuotas({
			getGlobalModelRuntime: getAuth,
			readStoredProfileCredential: getAuth,
		});
		const runtime: QuotaRuntime = { getAuth, getModels: () => [], isUsingOAuth: () => true };
		expect(
			await providerQuota(
				runtime,
				{ id, name: id, baseUrl: "https://untrusted.example/api" },
				new AbortController().signal,
			),
		).toMatchObject({ status: "unsupported", error: null, windows: [], amounts: [] });
		expect(getAuth).not.toHaveBeenCalled();
	});
	it("keeps a successful provider when another supported provider has invalid account data", async () => {
		const fetch = vi.fn(async (url: string) =>
			Response.json(
				url.includes("deepseek")
					? {
							is_available: true,
							balance_infos: [{ currency: "USD", total_balance: "2", granted_balance: "0", topped_up_balance: "2" }],
						}
					: { invalid: true },
			),
		);
		vi.stubGlobal("fetch", fetch);
		const runtime: QuotaRuntime = {
			getAuth: async () => ({ auth: { apiKey: "synthetic-key" } }),
			getModels: () => [],
			isUsingOAuth: () => false,
		};
		const owner = createPiProviderQuotas({
			getGlobalModelRuntime: async () => {
				throw new Error("not used");
			},
			readStoredProfileCredential: async () => undefined,
		});
		try {
			const [available, failed] = await Promise.all([
				owner.providerQuota(
					runtime,
					{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/" },
					new AbortController().signal,
				),
				owner.providerQuota(
					runtime,
					{ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
					new AbortController().signal,
				),
			]);
			expect(available).toMatchObject({ status: "available", amounts: [{ value: 2, unit: "USD" }] });
			expect(failed).toMatchObject({ status: "error", error: "invalid-response" });
			expect(fetch.mock.calls.map(([url]) => url)).toEqual([
				"https://api.deepseek.com/user/balance",
				"https://openrouter.ai/api/v1/key",
			]);
		} finally {
			await owner.dispose();
		}
	});
	it("cancels authentication waits and rejects new work after its owner is disposed", async () => {
		const runtime: QuotaRuntime = {
			getAuth: () => new Promise(() => undefined),
			getModels: () => [],
			isUsingOAuth: () => false,
		};
		const owner = createPiProviderQuotas({
			getGlobalModelRuntime: async () => {
				throw new Error("not used");
			},
			readStoredProfileCredential: async () => undefined,
		});
		const provider = { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" };
		const pending = owner.providerQuota(runtime, provider, new AbortController().signal);
		const cancelled = expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		await owner.dispose();
		await cancelled;
		await expect(owner.providerQuota(runtime, provider, new AbortController().signal)).rejects.toMatchObject({
			code: "REQUEST_CANCELLED",
		});
	});
	it.each([
		["openai-codex", "https://chatgpt.com/backend-api"],
		["anthropic", "https://api.anthropic.com"],
		["github-copilot", "https://api.individual.githubcopilot.com"],
		["xai", "https://api.x.ai/v1"],
	])("rejects API-key mode for OAuth account endpoint %s", async (id, baseUrl) => {
		const getAuth = vi.fn(() => {
			throw new Error("Unexpected credential access");
		});
		const { providerQuota } = createPiProviderQuotas({
			getGlobalModelRuntime: getAuth,
			readStoredProfileCredential: getAuth,
		});
		const runtime: QuotaRuntime = { getAuth, getModels: () => [], isUsingOAuth: () => false };
		expect(await providerQuota(runtime, { id, name: id, baseUrl }, new AbortController().signal)).toMatchObject({
			status: "unsupported",
			error: null,
		});
		expect(getAuth).not.toHaveBeenCalled();
	});
});
