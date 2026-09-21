import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingRequests } from "./pending-requests";

function registry() {
	return createPendingRequests<{ host: object }>({
		capacity: 2,
		capacityError: () => new Error("Full"),
		createId: (n) => `request-${n}`,
	});
}

afterEach(() => vi.useRealTimers());

describe("pending request ownership", () => {
	it("isolates ids and capacity per owner, then releases capacity on settlement", async () => {
		const a = registry(),
			b = registry(),
			context = { host: {} };
		const first = a.create<number>({ context, deadline: null });
		const second = a.create<number>({ context, deadline: null });
		const other = b.create<number>({ context, deadline: null });
		expect(first.id).toBe(other.id);
		expect(second.id).not.toBe(first.id);
		expect(() => a.create({ context, deadline: null })).toThrow("Full");
		first.resolve(1);
		second.resolve(2);
		other.resolve(3);
		expect(await Promise.all([first.promise, second.promise, other.promise])).toEqual([1, 2, 3]);
		expect(a.size).toBe(0);
		expect(b.size).toBe(0);
	});
	it("rejects expired or cancelled waits before admission and releases listeners and timers", async () => {
		vi.useFakeTimers();
		const pending = registry(),
			context = { host: {} },
			controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const expired = vi.fn();
		const request = pending.create({
			context,
			deadline: { at: Date.now() + 100, error: () => new Error("Deadline") },
			signal: controller.signal,
			onExpired: expired,
		});
		const rejection = expect(request.promise).rejects.toThrow("Cancelled");
		controller.abort(new Error("Cancelled"));
		await rejection;
		expect(pending.size).toBe(0);
		expect(remove).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(expired).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Error), request.id);
		const already = pending.create({ context, deadline: null, signal: controller.signal });
		await expect(already.promise).rejects.toThrow("Cancelled");
		const deadline = pending.create({ context, deadline: { at: Date.now() - 1, error: () => new Error("Expired") } });
		await expect(deadline.promise).rejects.toThrow("Expired");
		expect(pending.size).toBe(0);
	});
	it("fences late settlement when an explicit id is reused after timeout", async () => {
		vi.useFakeTimers();
		const pending = registry(),
			context = { host: {} };
		const old = pending.create({
			id: "same",
			context,
			deadline: { at: Date.now() + 100, error: () => new Error("Expired") },
		});
		const rejection = expect(old.promise).rejects.toThrow("Expired");
		await vi.advanceTimersByTimeAsync(100);
		await rejection;
		const replacement = pending.create<number>({ id: "same", context, deadline: null });
		old.resolve(10);
		old.reject(new Error("Late"));
		expect(pending.size).toBe(1);
		replacement.resolve(20);
		expect(await replacement.promise).toBe(20);
	});
	it("rejects only the failed host and leaves other completed/pending results intact", async () => {
		const pending = registry(),
			firstHost = {},
			secondHost = {};
		const first = pending.create({ context: { host: firstHost }, deadline: null });
		const second = pending.create<number>({ context: { host: secondHost }, deadline: null });
		const rejection = expect(first.promise).rejects.toThrow("Lost");
		pending.rejectWhere((c) => c.host === firstHost, new Error("Lost"));
		await rejection;
		expect([...pending.keys()]).toEqual([second.id]);
		second.resolve(42);
		expect(await second.promise).toBe(42);
	});
});
