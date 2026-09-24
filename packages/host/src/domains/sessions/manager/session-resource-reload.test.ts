import { expect, it, vi } from "vitest";
import type { PiResourceReloadMode } from "@ling/contracts/session";
import { createSessionResourceReloadController } from "./session-resource-reload";

it("retains a deferred full reload across later configuration changes", async () => {
	let busy = true;
	const reloadResources = vi.fn(async (_mode?: PiResourceReloadMode) => {
		if (busy) throw Object.assign(new Error("busy"), { code: "SESSION_RESOURCE_RELOAD_BUSY" });
	});
	const controller = createSessionResourceReloadController({
		runtime: () => ({ isBusy: () => busy, reloadResources }),
		isCurrent: () => true,
		sessionId: () => "fixture",
		track: (work) => work,
		suspendExtensionUiEvents: () => {},
		resumeExtensionUiEvents: () => {},
		appliedRevisionAtCreation: 0,
		latestRevisionAtCreation: 0,
	});
	controller.requestRevision(1, "full");
	await controller.reconcile(1);
	controller.requestRevision(2, "configuration");
	await controller.reconcile(2);
	expect(controller.hasApplied(2)).toBe(false);
	busy = false;
	await controller.reconcile(2);
	expect(reloadResources.mock.calls.map(([mode]) => mode)).toEqual(["full", "full"]);
	expect(controller.hasApplied(2)).toBe(true);
	controller.requestRevision(3, "configuration");
	await controller.reconcile(3);
	expect(reloadResources).toHaveBeenLastCalledWith("configuration");
	await controller.drain();
});

it("does not credit an in-flight configuration reload for a later full reload", async () => {
	const release = Promise.withResolvers<void>();
	const reloadResources = vi.fn(async (_mode?: PiResourceReloadMode) => {
		if (reloadResources.mock.calls.length === 1) await release.promise;
	});
	const controller = createSessionResourceReloadController({
		runtime: () => ({ isBusy: () => false, reloadResources }),
		isCurrent: () => true,
		sessionId: () => "fixture",
		track: (work) => work,
		suspendExtensionUiEvents: () => {},
		resumeExtensionUiEvents: () => {},
		appliedRevisionAtCreation: 0,
		latestRevisionAtCreation: 0,
	});
	controller.requestRevision(1, "configuration");
	const first = controller.reconcile(1);
	controller.requestRevision(2, "full");
	const second = controller.reconcile(2);
	release.resolve();
	await Promise.all([first, second]);
	expect(reloadResources.mock.calls.map(([mode]) => mode)).toEqual(["configuration", "full"]);
	expect(controller.hasApplied(2)).toBe(true);
	await controller.drain();
});
