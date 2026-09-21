import { describe, expect, it, vi } from "vitest";
import { createFeatureSnapshot } from "./feature-snapshot";

describe("feature snapshot ownership", () => {
	it("keeps the latest successful data when a later refresh fails", async () => {
		const older = Promise.withResolvers<string>();
		const load = vi.fn<() => Promise<string>>().mockReturnValueOnce(older.promise).mockResolvedValueOnce("latest");
		const owner = createFeatureSnapshot(load);
		const stop = owner.start();
		const pending = owner.refresh();
		await owner.refresh();
		older.resolve("stale");
		await pending;
		const error = new Error("Read failed");
		load.mockRejectedValueOnce(error);
		await owner.refresh();
		expect(owner.getSnapshot()).toEqual({ value: "latest", error, busy: false });
		stop();
	});

	it.each(["resolve", "reject"] as const)("fences an action that %s after its scope is retired", async (settle) => {
		const pending = Promise.withResolvers<string>();
		const load = vi.fn(async () => "new scope");
		const success = vi.fn();
		const owner = createFeatureSnapshot(load);
		const stop = owner.start();
		const action = owner.act(() => pending.promise, success);
		stop();
		const stopAgain = owner.start();
		await owner.refresh();
		if (settle === "resolve") pending.resolve("old result");
		else pending.reject(new Error("Old failure"));
		expect(await action).toBe(false);
		expect(success).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledTimes(1);
		expect(owner.getSnapshot()).toEqual({ value: "new scope", error: null, busy: false });
		stopAgain();
	});

	it("serializes actions and releases admission after a failure", async () => {
		const pending = Promise.withResolvers<void>();
		const owner = createFeatureSnapshot(async () => "loaded");
		const stop = owner.start();
		const first = owner.act(() => pending.promise);
		const second = vi.fn();
		expect(await owner.act(second)).toBe(false);
		expect(second).not.toHaveBeenCalled();
		pending.reject(new Error("Mutation failed"));
		expect(await first).toBe(false);
		expect(owner.getSnapshot().busy).toBe(false);
		expect(await owner.act(async () => "done")).toBe(true);
		expect(owner.getSnapshot()).toEqual({ value: "loaded", error: null, busy: false });
		stop();
	});
});
