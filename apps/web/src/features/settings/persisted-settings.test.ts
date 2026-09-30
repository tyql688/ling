import { describe, expect, it } from "vitest";
import { createPersistedSettingsMutationQueue } from "./persisted-settings";

describe("persisted settings mutations", () => {
	it("serializes writes and publishes only the latest requested result", async () => {
		const queue = createPersistedSettingsMutationQueue();
		const release = Promise.withResolvers<void>();
		let persisted = "initial";
		const read = async () => persisted;
		const first = queue.run(async () => {
			await release.promise;
			persisted = "first";
			return persisted;
		}, read);
		const second = queue.run(async () => {
			persisted = `${await read()} + second`;
			return persisted;
		}, read);
		release.resolve();
		const [earlier, latest] = await Promise.all([first, second]);
		expect(persisted).toBe("first + second");
		expect(queue.isCurrent(earlier.revision)).toBe(false);
		expect(queue.isCurrent(latest.revision)).toBe(true);
		expect(latest.result).toEqual({ status: "saved", value: "first + second" });
	});

	it("reconciles a partial write failure before admitting the next mutation", async () => {
		const queue = createPersistedSettingsMutationQueue();
		const reloadError = new Error("Live resource reload failed");
		const readRelease = Promise.withResolvers<void>();
		let persisted = "initial";
		const first = queue.run(
			async () => {
				persisted = "saved before reload failure";
				throw reloadError;
			},
			async () => {
				await readRelease.promise;
				return persisted;
			},
		);
		const second = queue.run(
			async () => {
				persisted = "second";
				return persisted;
			},
			async () => persisted,
		);
		readRelease.resolve();
		const [partial, latest] = await Promise.all([first, second]);
		expect(partial.result).toEqual({
			status: "failed",
			error: reloadError,
			persisted: { status: "ready", value: "saved before reload failure" },
		});
		expect(latest.result).toEqual({ status: "saved", value: "second" });
	});

	it("retains both failures when the persisted value cannot be read", async () => {
		const queue = createPersistedSettingsMutationQueue();
		const writeError = new Error("Write failed");
		const readError = new Error("Read failed");
		const outcome = await queue.run(
			async () => {
				throw writeError;
			},
			async () => {
				throw readError;
			},
		);
		expect(outcome.result).toEqual({
			status: "failed",
			error: writeError,
			persisted: { status: "unavailable", error: readError },
		});
	});

	it("fences a pending result when its view owner is invalidated", async () => {
		const queue = createPersistedSettingsMutationQueue();
		const release = Promise.withResolvers<string>();
		const pending = queue.run(
			() => release.promise,
			async () => "persisted",
		);
		queue.invalidate();
		release.resolve("saved");
		const outcome = await pending;
		expect(outcome.result).toEqual({ status: "saved", value: "saved" });
		expect(queue.isCurrent(outcome.revision)).toBe(false);
	});
});
