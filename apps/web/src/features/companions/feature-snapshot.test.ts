import { describe, expect, it, vi } from "vitest";
import { createFeatureSnapshot } from "./feature-snapshot";

describe("feature snapshot ownership", () => {
	it("coalesces change events during an action into one settled read", async () => {
		const load = vi.fn(async () => "saved");
		const owner = createFeatureSnapshot(load);
		const stop = owner.start();
		await owner.act(async () => {
			await owner.refresh();
			await owner.refresh();
			expect(load).not.toHaveBeenCalled();
		});
		expect(load).toHaveBeenCalledOnce();
		expect(owner.getSnapshot()).toEqual({ value: "saved", error: null, busy: false });
		stop();
	});

	it("refreshes partial writes while retaining the failure and fences pre-action reads", async () => {
		const older = Promise.withResolvers<string>();
		const load = vi.fn<() => Promise<string>>().mockReturnValueOnce(older.promise).mockResolvedValue("persisted");
		const owner = createFeatureSnapshot(load);
		const stop = owner.start();
		const reading = owner.refresh();
		const error = new Error("Reload failed after saving");
		expect(
			await owner.act(async () => {
				await owner.refresh();
				throw error;
			}),
		).toBe(false);
		older.resolve("old");
		await reading;
		expect(load).toHaveBeenCalledTimes(2);
		expect(owner.getSnapshot()).toEqual({ value: "persisted", error, busy: false });
		stop();
	});

	it.each([false, true])("keeps external changes during the final refresh, mutation failed: %s", async (failed) => {
		const first = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		const load = vi
			.fn<() => Promise<string>>()
			.mockImplementationOnce(() => {
				started.resolve();
				return first.promise;
			})
			.mockResolvedValue("external change");
		const owner = createFeatureSnapshot(load);
		const stop = owner.start();
		const error = new Error("Partially saved");
		const action = owner.act(async () => {
			if (failed) throw error;
		});
		await started.promise;
		await owner.refresh();
		first.resolve("own change");
		expect(await action).toBe(!failed);
		expect(owner.getSnapshot()).toEqual({ value: "external change", error: failed ? error : null, busy: false });
		stop();
	});

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
