import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProviderQuotaCache,
	ProviderQuotaReadError,
	resolveProviderAuth,
	type ProviderQuotaData,
	type QuotaRuntime,
} from "./shared";

const caches: ReturnType<typeof createProviderQuotaCache>[] = [];
const policy = { successMs: 100, failureMs: 10, rateLimitMs: 50 };
const data: ProviderQuotaData = { plan: null, windows: [], amounts: [] };
const signal = () => new AbortController().signal;
function cache() {
	const instance = createProviderQuotaCache();
	caches.push(instance);
	return instance;
}
afterEach(async () => {
	await Promise.all(caches.splice(0).map((entry) => entry.dispose()));
	vi.useRealTimers();
});

describe("quota cache ownership", () => {
	it("shares credential reads while cancellation only releases the original caller", async () => {
		const owner = cache();
		const result = Promise.withResolvers<ProviderQuotaData>();
		const load = vi.fn(() => result.promise);
		const caller = new AbortController();
		const first = owner.read("anthropic", "synthetic-a", policy, caller.signal, load);
		const cancelled = expect(first).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		const second = owner.read("anthropic", "synthetic-a", policy, signal(), load);
		caller.abort();
		await cancelled;
		result.resolve(data);
		await expect(second).resolves.toEqual(data);
		expect(load).toHaveBeenCalledOnce();
	});
	it("isolates credentials and owners, expires successes and applies distinct failure backoffs", async () => {
		vi.useFakeTimers();
		const owner = cache();
		const load = vi.fn(async () => data);
		await owner.read("anthropic", "a", policy, signal(), load);
		await owner.read("anthropic", "b", policy, signal(), load);
		await cache().read("anthropic", "a", policy, signal(), load);
		await owner.read("anthropic", "a", policy, signal(), load);
		expect(load).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(100);
		await owner.read("anthropic", "a", policy, signal(), load);
		expect(load).toHaveBeenCalledTimes(4);
		for (const [code, ttl] of [
			["service", 10],
			["rate-limit", 50],
		] as const) {
			const failure = vi.fn(async () => {
				throw new ProviderQuotaReadError(code);
			});
			await expect(owner.read("anthropic", code, policy, signal(), failure)).rejects.toMatchObject({ code });
			await vi.advanceTimersByTimeAsync(ttl - 1);
			await expect(owner.read("anthropic", code, policy, signal(), failure)).rejects.toMatchObject({ code });
			expect(failure).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			await expect(owner.read("anthropic", code, policy, signal(), failure)).rejects.toMatchObject({ code });
			expect(failure).toHaveBeenCalledTimes(2);
		}
	});
	it("bounds concurrent credential generations and drains them on disposal", async () => {
		const owner = cache();
		const load = (signal: AbortSignal) =>
			new Promise<ProviderQuotaData>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		const requests = Array.from({ length: 32 }, (_, index) =>
			owner.read("anthropic", String(index), policy, signal(), load),
		);
		const outcomes = Promise.allSettled(requests);
		expect(() => owner.read("anthropic", "overflow", policy, signal(), load)).toThrow(ProviderQuotaReadError);
		await Promise.resolve();
		const disposal = owner.dispose();
		expect(owner.dispose()).toBe(disposal);
		await disposal;
		expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
		expect(() => owner.read("anthropic", "late", policy, signal(), load)).toThrow(
			expect.objectContaining({ code: "REQUEST_CANCELLED" }),
		);
	});
	it("releases a cancelled credential lookup even when the upstream provider ignores abort", async () => {
		const deferred = Promise.withResolvers<undefined>();
		const runtime: QuotaRuntime = { getAuth: () => deferred.promise, getModels: () => [], isUsingOAuth: () => true };
		const caller = new AbortController();
		const request = resolveProviderAuth(runtime, "anthropic", caller.signal);
		const cancelled = expect(request).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		caller.abort();
		await cancelled;
		deferred.reject(new Error("late upstream failure"));
		await Promise.resolve();
	});
});
