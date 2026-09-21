import { describe, expect, it, vi } from "vitest";
import { createSessionLifecycleEvents } from "./session-lifecycle-events";

const ref = { cwd: "/project", sessionId: "session" };

describe("session lifecycle event ownership", () => {
	it("isolates listeners and disposes only the owning manager", () => {
		const first = createSessionLifecycleEvents();
		const second = createSessionLifecycleEvents();
		const firstListener = vi.fn();
		const secondListener = vi.fn();
		first.onSessionTitleChanged(firstListener);
		second.onSessionTitleChanged(secondListener);
		first.publishSessionTitleChanged(ref, "first");
		expect(firstListener).toHaveBeenCalledWith(ref, "first");
		expect(secondListener).not.toHaveBeenCalled();
		first.dispose();
		first.publishSessionTitleChanged(ref, "disposed");
		second.publishSessionTitleChanged(ref, "second");
		expect(firstListener).toHaveBeenCalledTimes(1);
		expect(secondListener).toHaveBeenCalledWith(ref, "second");
		second.dispose();
	});

	it("keeps peer notifications working when one subscriber fails", () => {
		const events = createSessionLifecycleEvents();
		const unsubscribe = events.onSessionTitleChanged(() => {
			throw new Error("subscriber failed");
		});
		const peer = vi.fn();
		events.onSessionTitleChanged(peer);
		events.publishSessionTitleChanged(ref, "updated");
		expect(peer).toHaveBeenCalledWith(ref, "updated");
		unsubscribe();
		events.dispose();
	});
});
