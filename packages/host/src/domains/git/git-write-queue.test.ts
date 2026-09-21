import { describe, expect, it, vi } from "vitest";
import { createGitWriteQueue } from "./git-write-queue";

describe("Git write queue ownership", () => {
	it("serializes one root without blocking independent roots or instances", async () => {
		const first = createGitWriteQueue();
		const second = createGitWriteQueue();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const order: string[] = [];
		const active = first.runBoundedGitWriteAtRoot("/project", async () => {
			entered.resolve();
			await release.promise;
			order.push("active");
		});
		await entered.promise;
		const queued = first.runBoundedGitWriteAtRoot("/project", async () => {
			order.push("queued");
		});
		await second.runBoundedGitWriteAtRoot("/project", async () => {
			order.push("independent instance");
		});
		await first.runBoundedGitWriteAtRoot("/another", async () => {
			order.push("independent root");
		});
		expect(order).toEqual(["independent instance", "independent root"]);
		release.resolve();
		await Promise.all([active, queued]);
		expect(order).toEqual(["independent instance", "independent root", "active", "queued"]);
		await Promise.all([first.dispose(), second.dispose()]);
	});

	it("cancels queued work, marks admitted work uncertain, and drains its underlying operation", async () => {
		const owner = createGitWriteQueue();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const active = owner.runBoundedGitWriteAtRoot("/project", async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const neverStarted = vi.fn(async () => undefined);
		const queued = owner.runBoundedGitWriteAtRoot("/project", neverStarted);
		const outcomes = Promise.allSettled([active, queued]);
		const disposed = owner.dispose();
		expect(owner.dispose()).toBe(disposed);
		expect(await outcomes).toMatchObject([
			{ status: "rejected", reason: { code: "GIT_OPERATION_UNCERTAIN" } },
			{ status: "rejected", reason: { code: "REQUEST_CANCELLED" } },
		]);
		let drained = false;
		void disposed.then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		release.resolve();
		await disposed;
		expect(neverStarted).not.toHaveBeenCalled();
		await expect(owner.runBoundedGitWriteAtRoot("/project", neverStarted)).rejects.toMatchObject({
			code: "REQUEST_CANCELLED",
		});
	});
});
