import { expect, it, vi } from "vitest";
import type { SessionRef } from "@ling/contracts/session";
import type { ManagedSessionManager } from "./manager/session-manager";
import { createSessionRuntimeRetentionHost } from "./session-runtime-retention";
import { createHostClientState } from "../../transport/client-state";

function retentionHarness() {
	const live = new Map<string, SessionRef>();
	const expired = new Set<string>();
	const clients = createHostClientState();
	let beforeDisposal: () => Promise<void> = () => Promise.resolve();
	const suspendSessionIfIdle: ManagedSessionManager["suspendSessionIfIdle"] = async (ref, before, after) => {
		await beforeDisposal();
		if (!before(ref)) return false;
		live.delete(ref.sessionId);
		after(ref);
		return true;
	};
	const options = {
		manager: {
			registry: {
				findManagedSession: (ref: SessionRef) => live.get(ref.sessionId),
				listIdleManagedSessionEvictionCandidates: (protectedRefs: readonly SessionRef[]) =>
					[...live.values()].filter(
						(ref) =>
							expired.has(ref.sessionId) &&
							!protectedRefs.some((protectedRef) => protectedRef.sessionId === ref.sessionId),
					),
			},
			suspendSessionIfIdle,
		} as unknown as ManagedSessionManager,
		pendingInteractionRefs: () => [],
		viewedSessionRefs: clients.viewedSessionRefs,
		onSuspending: () => {},
		onSuspended: () => {},
	};
	return {
		retention: createSessionRuntimeRetentionHost(options),
		live,
		expired,
		clients,
		pauseDisposal(wait: () => Promise<void>) {
			beforeDisposal = wait;
		},
	};
}

it("keeps the user's selected session when a background task prepares another runtime", async () => {
	vi.useFakeTimers();
	const h = retentionHarness();
	const selected = { cwd: "/fixture", sessionId: "selected" };
	const background = { cwd: "/fixture", sessionId: "background" };
	h.live.set(selected.sessionId, selected);
	h.live.set(background.sessionId, background);
	try {
		h.retention.retain(selected);
		await vi.advanceTimersByTimeAsync(0);
		h.expired.add(selected.sessionId);
		h.retention.retain(background, { selection: false });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.live.has(selected.sessionId)).toBe(true);
		h.expired.clear();
		h.retention.retain(background);
		await vi.advanceTimersByTimeAsync(0);
		h.expired.add(background.sessionId);
		h.retention.retain(selected, { selection: false });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.live.has(background.sessionId)).toBe(true);
	} finally {
		await h.retention.dispose();
		vi.useRealTimers();
	}
});

it("protects every client's viewed session and releases that protection when the client leaves", async () => {
	vi.useFakeTimers();
	const h = retentionHarness();
	const first = { cwd: "/fixture", sessionId: "first" };
	const second = { cwd: "/fixture", sessionId: "second" };
	h.live.set(first.sessionId, first);
	h.live.set(second.sessionId, second);
	h.clients.setViewedSession("first-client", first);
	h.clients.setViewedSession("second-client", second);
	h.expired.add(first.sessionId);
	try {
		h.retention.retain(second);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.live.has(first.sessionId)).toBe(true);
		h.clients.disconnect("first-client");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.live.has(first.sessionId)).toBe(false);
		expect(h.live.has(second.sessionId)).toBe(true);
	} finally {
		await h.retention.dispose();
		vi.useRealTimers();
	}
});

it("rechecks the viewed session after asynchronous retirement preparation", async () => {
	vi.useFakeTimers();
	const h = retentionHarness();
	const ref = { cwd: "/fixture", sessionId: "reselected" };
	const gate = Promise.withResolvers<void>();
	h.live.set(ref.sessionId, ref);
	h.expired.add(ref.sessionId);
	h.pauseDisposal(() => gate.promise);
	try {
		h.retention.reap();
		h.clients.setViewedSession("client", ref);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.live.has(ref.sessionId)).toBe(true);
	} finally {
		gate.resolve();
		await h.retention.dispose();
		vi.useRealTimers();
	}
});

it("reaps expired workers without user activity and stops its timer before shutdown", async () => {
	vi.useFakeTimers();
	const ref: SessionRef = { cwd: "/fixture", sessionId: "idle" };
	let live = true;
	const retired: SessionRef[] = [];
	const suspendSessionIfIdle: ManagedSessionManager["suspendSessionIfIdle"] = async (candidate, before, after) => {
		if (!before(candidate)) return false;
		live = false;
		after(candidate);
		return true;
	};
	const retention = createSessionRuntimeRetentionHost({
		manager: {
			registry: {
				findManagedSession: () => (live ? {} : undefined),
				listIdleManagedSessionEvictionCandidates: () => (live ? [ref] : []),
			},
			suspendSessionIfIdle,
		} as unknown as ManagedSessionManager,
		pendingInteractionRefs: () => [],
		viewedSessionRefs: () => [],
		onSuspending: () => {},
		onSuspended: (candidate) => retired.push(candidate),
	});
	try {
		await vi.advanceTimersByTimeAsync(30_000);
		expect(retired).toEqual([ref]);
		retention.prepareShutdown();
		live = true;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(retired).toEqual([ref]);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		await retention.dispose();
		vi.useRealTimers();
	}
});
