import { describe, expect, it } from "vitest";
import type { Schedule, ScheduleOccurrence } from "@ling/contracts/schedules";
import { appendOccurrence, nextOccurrence } from "./calendar";
const daily = (time: string, timeZone = "America/New_York"): Schedule => ({
	kind: "calendar",
	time,
	timeZone,
	days: [0, 1, 2, 3, 4, 5, 6],
});
describe("Schedule clock interpretation", () => {
	it("bounds retained history without dropping an active receipt", () => {
		const receipt = (id: string, startedAt: number): ScheduleOccurrence => ({
			id,
			taskId: "task",
			taskRevision: 1,
			scheduledAt: startedAt,
			startedAt,
			finishedAt: startedAt,
			runId: null,
			sessionId: null,
			cwd: "/example",
			status: "completed",
			error: null,
			summary: "",
			unread: true,
		});
		const active = { ...receipt("active", 0), status: "running" as const, finishedAt: null };
		const history = [active, ...Array.from({ length: 100 }, (_, i) => receipt(String(i), i + 1))];
		const result = appendOccurrence(history, receipt("latest", 200));
		expect(result).toHaveLength(100);
		expect(result[0]).toEqual(active);
		expect(result.at(-1)?.id).toBe("latest");
	});
	it("moves a spring gap to the first valid minute and runs a fold only once", () => {
		expect(new Date(nextOccurrence(daily("02:30"), Date.parse("2026-03-08T05:00:00Z"))!).toISOString()).toBe(
			"2026-03-08T07:00:00.000Z",
		);
		expect(new Date(nextOccurrence(daily("01:30"), Date.parse("2026-11-01T04:00:00Z"))!).toISOString()).toBe(
			"2026-11-01T05:30:00.000Z",
		);
		expect(new Date(nextOccurrence(daily("01:30"), Date.parse("2026-11-01T05:30:00Z"))!).toISOString()).toBe(
			"2026-11-02T06:30:00.000Z",
		);
	});
	it("preserves interval anchors without replaying a missed backlog", () => {
		expect(nextOccurrence({ kind: "interval", anchor: 1000, minutes: 5 }, 1_000_000)).toBe(1_201_000);
		expect(nextOccurrence({ kind: "once", at: 1000 }, 1000)).toBeNull();
	});
	it("uses weekdays in the configured zone across a UTC date boundary", () => {
		expect(
			new Date(
				nextOccurrence(
					{ kind: "calendar", time: "09:00", timeZone: "Asia/Shanghai", days: [1] },
					Date.parse("2026-09-13T20:00:00Z"),
				)!,
			).toISOString(),
		).toBe("2026-09-14T01:00:00.000Z");
	});
});
