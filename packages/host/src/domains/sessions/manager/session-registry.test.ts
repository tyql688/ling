import { createExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type { SessionRuntimeProvider } from "@ling/core/pi-protocol/runtime-provider";
import { expect, it } from "vitest";
import { createSessionLifecycleEvents } from "./session-lifecycle-events";
import { createSessionLifecycleOperations } from "./session-lifecycle-operations";
import { createSessionRegistry } from "./session-registry";

it("counts protected idle sessions toward the warm budget without retiring busy, interactive or changing runtimes", async () => {
	const lifecycleEvents = createSessionLifecycleEvents();
	const lifecycleOperations = createSessionLifecycleOperations();
	const registry = createSessionRegistry({
		extensionUi: createExtensionUiBridge(),
		lifecycleEvents,
		lifecycleOperations,
		runtimeProvider: { resolveProject: () => "/fixture" } as unknown as SessionRuntimeProvider,
	});
	const unsubscribe = () => () => {};
	const add = (sessionId: string, busy = false) => {
		const ref = { cwd: "/fixture", sessionId };
		const runtime = {
			ref,
			isBusy: () => busy,
			listCommands: () => ({ extensions: [], skills: [], prompts: [] }),
			subscribe: unsubscribe,
			setReplacementCoordinator: unsubscribe,
			onSessionReplaced: unsubscribe,
			onSnapshotChanged: unsubscribe,
			onTranscriptInvalidated: unsubscribe,
			onTranscriptProjectionChanged: unsubscribe,
			onLifecycleFailed: unsubscribe,
			dispose: () => Promise.resolve(),
		} as unknown as SessionRuntimePort;
		return registry.attachManagedSession(ref, runtime, ref.cwd, {
			resourceRevisionAtCreation: 0,
			latestResourceRevision: 0,
		});
	};
	const oldest = add("oldest");
	const recent = add("recent");
	const selected = add("selected");
	const running = add("running", true);
	const changing = add("changing");
	const change = Promise.withResolvers<void>();
	const changingOperation = lifecycleOperations.registerOpeningSession(changing.ref, change.promise);
	try {
		expect(registry.listIdleManagedSessionEvictionCandidates([selected.ref])).toEqual([oldest.ref]);
		expect(registry.listIdleManagedSessionEvictionCandidates([oldest.ref, selected.ref])).toEqual([recent.ref]);
		expect(registry.listIdleManagedSessionEvictionCandidates([oldest.ref, recent.ref, selected.ref])).toEqual([]);
		registry.touchManagedSession(oldest);
		expect(registry.listIdleManagedSessionEvictionCandidates([selected.ref])).toEqual([recent.ref]);
		await registry.disposeManagedSession(oldest);
		expect(registry.listIdleManagedSessionEvictionCandidates([selected.ref])).toEqual([]);
		for (const managed of [recent, selected, running, changing]) managed.lastAccessAt = Date.now() - 120_001;
		// Even below the warm count, age releases an unused worker without touching the
		// selected session, pending interactions, running work or lifecycle transitions.
		expect(registry.listIdleManagedSessionEvictionCandidates([selected.ref])).toEqual([recent.ref]);
		expect(registry.listIdleManagedSessionEvictionCandidates([recent.ref, selected.ref])).toEqual([]);
		registry.touchManagedSession(recent);
		expect(registry.listIdleManagedSessionEvictionCandidates([selected.ref])).toEqual([]);
	} finally {
		change.resolve();
		await changingOperation;
		await Promise.all(registry.listManagedSessions().map((managed) => registry.disposeManagedSession(managed)));
		lifecycleEvents.dispose();
	}
});
