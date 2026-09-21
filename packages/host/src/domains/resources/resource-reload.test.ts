import { describe, expect, it, vi } from "vitest";
import type { SessionResourceReloadSummary } from "@ling/contracts/session";
import { createResourceReloadCoordinator } from "./resource-reload";

function summary(revision = 1): SessionResourceReloadSummary {
	return { revision, reloaded: 0, deferred: 0, failed: [], failedOmitted: 0 };
}

describe("resource reload ownership", () => {
	it("serializes each project and session pair and coalesces one accepted follow-up", async () => {
		const release = Promise.withResolvers<void>();
		const order: string[] = [];
		let revision = 0;
		const owner = createResourceReloadCoordinator({
			async reloadProjectSettings() {
				revision += 1;
				order.push(`project:${revision}`);
				if (revision === 1) await release.promise;
			},
			async reloadSessionResources() {
				order.push(`session:${revision}`);
				return summary(revision);
			},
		});
		const first = owner.reloadPiResources();
		const second = owner.reloadPiResources();
		expect(owner.reloadPiResources()).toBe(second);
		const disposed = owner.dispose();
		expect(owner.dispose()).toBe(disposed);
		await expect(owner.reloadPiResources()).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		release.resolve();
		await expect(first).resolves.toMatchObject({ sessions: { revision: 1 } });
		await expect(second).resolves.toMatchObject({ sessions: { revision: 2 } });
		await disposed;
		expect(order).toEqual(["project:1", "session:1", "project:2", "session:2"]);
	});

	it("continues session reconciliation after a project failure and does not notify another instance", async () => {
		const first = createResourceReloadCoordinator({
			reloadProjectSettings: async () => {
				throw new Error("catalog unavailable");
			},
			reloadSessionResources: async () => summary(),
		});
		const second = createResourceReloadCoordinator({
			reloadProjectSettings: async () => undefined,
			reloadSessionResources: async () => summary(),
		});
		const firstListener = vi.fn();
		const secondListener = vi.fn();
		first.onPiResourcesReloaded(firstListener);
		second.onPiResourcesReloaded(secondListener);
		await expect(first.reloadPiResources()).resolves.toMatchObject({
			projectError: "catalog unavailable",
			sessionError: null,
			sessions: { revision: 1 },
		});
		expect(firstListener).toHaveBeenCalledOnce();
		expect(secondListener).not.toHaveBeenCalled();
		await Promise.all([first.dispose(), second.dispose()]);
	});

	it("drains an admitted mutation and its reload when disposal starts before the write settles", async () => {
		const release = Promise.withResolvers<void>();
		const reload = vi.fn(async () => summary());
		const owner = createResourceReloadCoordinator({
			reloadProjectSettings: async () => undefined,
			reloadSessionResources: reload,
		});
		const changed = owner.mutateThenReloadPiResources("mutation and reload failed", () => release.promise);
		const disposed = owner.dispose();
		const rejectedMutation = vi.fn(async () => undefined);
		await expect(owner.mutateThenReloadPiResources("stopped", rejectedMutation)).rejects.toMatchObject({
			code: "REQUEST_CANCELLED",
		});
		expect(rejectedMutation).not.toHaveBeenCalled();
		release.resolve();
		await changed;
		await disposed;
		expect(reload).toHaveBeenCalledOnce();
	});

	it("merges targeted mutations into one follow-up without reloading unrelated projects", async () => {
		const release = Promise.withResolvers<void>();
		const scopes: Array<readonly string[] | undefined> = [];
		const sessions: Array<readonly string[] | undefined> = [];
		const owner = createResourceReloadCoordinator({
			async reloadProjectSettings(cwds) {
				scopes.push(cwds);
				if (scopes.length === 1) await release.promise;
			},
			async reloadSessionResources(cwds) {
				sessions.push(cwds);
				return summary();
			},
		});
		const first = owner.mutateThenReloadPiResources("failed", async () => ["alpha"]);
		await Promise.resolve();
		const second = owner.mutateThenReloadPiResources("failed", async () => ["beta"]);
		const third = owner.mutateThenReloadPiResources("failed", async () => ["gamma", "beta"]);
		await Promise.resolve();
		release.resolve();
		await Promise.all([first, second, third]);
		expect(scopes).toEqual([["alpha"], ["beta", "gamma"]]);
		expect(sessions).toEqual(scopes);
		await owner.dispose();
	});

	it("keeps a queued global reload global when later project mutations join it", async () => {
		const release = Promise.withResolvers<void>();
		const scopes: Array<readonly string[] | undefined> = [];
		const owner = createResourceReloadCoordinator({
			async reloadProjectSettings(cwds) {
				scopes.push(cwds);
				if (scopes.length === 1) await release.promise;
			},
			reloadSessionResources: async () => summary(),
		});
		const first = owner.mutateThenReloadPiResources("failed", async () => ["alpha"]);
		await Promise.resolve();
		const global = owner.reloadPiResources();
		const project = owner.mutateThenReloadPiResources("failed", async () => ["beta"]);
		await Promise.resolve();
		release.resolve();
		await Promise.all([first, global, project]);
		expect(scopes).toEqual([["alpha"], undefined]);
		await owner.dispose();
	});

	it("skips project loaders when effective resources are unchanged but reconciles uncertain failed writes", async () => {
		const project = vi.fn(async () => undefined);
		const session = vi.fn(async (_cwds?: readonly string[]) => summary());
		const changed = vi.fn();
		const owner = createResourceReloadCoordinator({ reloadProjectSettings: project, reloadSessionResources: session });
		owner.onPiResourcesReloaded(changed);
		await owner.mutateThenReloadPiResources("failed", async () => []);
		expect(project).not.toHaveBeenCalled();
		expect(session).toHaveBeenCalledWith([]);
		expect(changed).not.toHaveBeenCalled();
		const error = new Error("write outcome uncertain");
		const result = await owner.mutateThenReloadPiResources("failed", async () => {
			throw error;
		});
		expect(result.mutation).toEqual({ failed: true, error });
		expect(project).toHaveBeenCalledWith(undefined);
		expect(session).toHaveBeenLastCalledWith(undefined);
		expect(changed).toHaveBeenCalledOnce();
		await owner.dispose();
	});
});
