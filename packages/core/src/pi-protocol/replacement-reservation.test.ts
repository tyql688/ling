import { describe, expect, it, vi } from "vitest";
import { createPiWorkerReplacementReservation } from "./replacement-reservation";

describe("Pi replacement reservation", () => {
	it("shares one commit transition and never aborts committed ownership", async () => {
		const transition = Promise.withResolvers<void>();
		const commit = vi.fn(() => transition.promise);
		const abort = vi.fn();
		const reservation = createPiWorkerReplacementReservation(1, "runtime", { commit, abort });
		const first = reservation.commit();
		expect(reservation.commit()).toBe(first);
		expect(reservation.abort()).toBe(first);
		transition.resolve();
		await first;
		await reservation.abort();
		expect(commit).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("aborts once and rejects subsequent commit admission", async () => {
		const abort = vi.fn();
		const commit = vi.fn();
		const reservation = createPiWorkerReplacementReservation(1, "runtime", { commit, abort });
		await Promise.all([reservation.abort(), reservation.abort()]);
		await expect(reservation.commit()).rejects.toThrow("already aborted");
		expect(abort).toHaveBeenCalledTimes(1);
		expect(commit).not.toHaveBeenCalled();
	});

	it("preserves both commit and rollback failures", async () => {
		const commitError = new Error("commit failed");
		const rollbackError = new Error("rollback failed");
		const reservation = createPiWorkerReplacementReservation(1, "runtime", {
			commit: () => {
				throw commitError;
			},
			abort: () => {
				throw rollbackError;
			},
		});
		await expect(reservation.commit()).rejects.toMatchObject({ errors: [commitError, rollbackError] });
		await expect(reservation.commit()).rejects.toThrow("already aborted");
	});
});
