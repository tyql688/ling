import { describe, expect, it, vi } from "vitest";
import { lingErrorDtoSchema } from "@ling/contracts/ling-error";
import { createLingError, requestCancelled, requestCapacityExceeded, waitForOperation } from "./ling-error";

describe("owned operation errors", () => {
	it("preserves typed capacity and cancellation errors across serialization", () => {
		const error = requestCapacityExceeded("requests", 4, "Too many requests");
		const dto = lingErrorDtoSchema.parse(JSON.parse(JSON.stringify(error.lingError)));
		expect(createLingError(dto).code).toBe("REQUEST_CAPACITY_EXCEEDED");
		expect(dto).toMatchObject({ retryable: true, details: { resource: "requests", capacity: 4 } });
	});
	it("releases its abort subscription and observes late upstream failure", async () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		let rejectUpstream!: (cause: unknown) => void;
		const upstream = new Promise<never>((_resolve, reject) => {
			rejectUpstream = reject;
		});
		const pending = waitForOperation(upstream, controller.signal);
		const reason = requestCancelled("Project closed");
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(remove).toHaveBeenCalledOnce();
		rejectUpstream(new Error("Late failure"));
		await Promise.resolve();
	});
});
