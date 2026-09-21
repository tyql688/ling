import { describe, expect, it } from "vitest";
import { createSessionLifecycleOperations } from "./session-lifecycle-operations";

const ref = { cwd: "/project", sessionId: "session" };

describe("session lifecycle ownership", () => {
	it("keeps operations for identical session refs isolated between managers", async () => {
		const first = createSessionLifecycleOperations();
		const second = createSessionLifecycleOperations();
		const pending = Promise.withResolvers<void>();
		const tracked = first.registerOpeningSession(ref, first.trackProjectSessionOperation(ref.cwd, pending.promise));
		expect(first.getOpeningSession(ref)).toBe(tracked);
		expect(first.hasSessionLifecycleOperation(ref)).toBe(true);
		expect(second.getOpeningSession(ref)).toBeUndefined();
		expect(second.hasProjectSessionOperations(ref.cwd)).toBe(false);
		await second.drain();
		pending.resolve();
		await first.drain();
		expect(first.getOpeningSession(ref)).toBeUndefined();
		expect(first.pendingProjectSessionOperations(ref.cwd)).toEqual([]);
	});

	it("does not let an older completion remove the newer owner of a ref", async () => {
		const operations = createSessionLifecycleOperations();
		const earlier = Promise.withResolvers<void>();
		const later = Promise.withResolvers<void>();
		const old = operations.registerClosingSession(ref, earlier.promise);
		const current = operations.registerClosingSession(ref, later.promise);
		earlier.resolve();
		await old;
		expect(operations.getClosingSession(ref)).toBe(current);
		later.resolve();
		await current;
		expect(operations.getClosingSession(ref)).toBeUndefined();
	});

	it("drains work registered by an accepted operation and reports failures", async () => {
		const operations = createSessionLifecycleOperations();
		const opening = Promise.withResolvers<void>();
		const child = Promise.withResolvers<void>();
		const parent = operations.trackProjectSessionOperation(
			ref.cwd,
			opening.promise.then(() => {
				void operations.trackSessionRuntimeCreation(child.promise).catch(() => undefined);
			}),
		);
		let settled = false;
		const draining = operations.drain();
		void draining.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		opening.resolve();
		await parent;
		expect(settled).toBe(false);
		const failure = new Error("runtime construction failed");
		child.reject(failure);
		await expect(draining).rejects.toMatchObject({ errors: [failure] });
		expect(operations.pendingSessionRuntimeCreations()).toEqual([]);
	});
});
