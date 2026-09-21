import { describe, expect, it } from "vitest";
import { createPiSettingsMutations } from "./settings-mutation";

describe("Pi settings mutation ownership", () => {
	it("drains admitted writes without blocking a different owner", async () => {
		const first = createPiSettingsMutations();
		const second = createPiSettingsMutations();
		const barrier = Promise.withResolvers<void>();
		const writes: string[] = [];
		const active = first.enqueueGlobalSettingsMutation(async () => {
			await barrier.promise;
			writes.push("first");
		});
		const queued = first.enqueueGlobalSettingsMutation(async () => {
			writes.push("queued");
		});
		const shutdown = first.shutdownGlobalSettingsMutations();
		expect(first.shutdownGlobalSettingsMutations()).toBe(shutdown);
		await expect(first.enqueueGlobalSettingsMutation(async () => {})).rejects.toMatchObject({
			code: "REQUEST_CANCELLED",
		});
		await second.enqueueGlobalSettingsMutation(async () => {
			writes.push("second");
		});
		expect(writes).toEqual(["second"]);
		barrier.resolve();
		await Promise.all([active, queued, shutdown, second.shutdownGlobalSettingsMutations()]);
		expect(writes).toEqual(["second", "first", "queued"]);
	});

	it("reports a failed write to its caller and still runs the next admitted write", async () => {
		const owner = createPiSettingsMutations();
		const failure = new Error("settings publication failed");
		const rejected = owner.enqueueGlobalSettingsMutation(async () => {
			throw failure;
		});
		const next = owner.enqueueGlobalSettingsMutation(async () => "published");
		await expect(rejected).rejects.toBe(failure);
		await expect(next).resolves.toBe("published");
		await owner.shutdownGlobalSettingsMutations();
	});
});
