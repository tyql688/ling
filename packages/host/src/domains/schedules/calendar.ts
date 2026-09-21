import type { Schedule, ScheduleOccurrence } from "@ling/contracts/schedules";

function local(time: number, format: Intl.DateTimeFormat) {
	const parts = Object.fromEntries(format.formatToParts(time).map((part) => [part.type, part.value]));
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
	};
}
const utc = (value: ReturnType<typeof local>) =>
	Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);

/** Wall-clock schedules choose the first fold occurrence; gaps move to the next valid local minute. */
export function nextOccurrence(schedule: Schedule, after: number): number | null {
	if (schedule.kind === "once") return schedule.at > after ? schedule.at : null;
	if (schedule.kind === "interval") {
		const interval = schedule.minutes * 60_000;
		return schedule.anchor + Math.max(0, Math.floor((after - schedule.anchor) / interval) + 1) * interval;
	}
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone: schedule.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	const here = local(after, format);
	const [hour, minute] = schedule.time.split(":").map(Number);
	// A weekly schedule needs at most the current day plus one full week.
	for (let day = 0; day < 8; day++) {
		const date = new Date(Date.UTC(here.year, here.month - 1, here.day + day));
		if (!schedule.days.includes(date.getUTCDay())) continue;
		const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
		const offsets = new Set(
			[-48, 0, 48].map((hours) => {
				const at = wall + hours * 3_600_000;
				return utc(local(at, format)) - at;
			}),
		);
		// Covers historical full-day zone jumps as well as ordinary one-hour DST gaps.
		for (let gap = 0; gap <= 1440; gap++) {
			const target = wall + gap * 60_000;
			const candidates = [...offsets]
				.map((offset) => target - offset)
				.filter((at) => utc(local(at, format)) === target)
				.sort((a, b) => a - b);
			if (candidates.length) {
				if (candidates[0]! > after) return candidates[0]!;
				break;
			}
		}
	}
	throw new Error("Could not resolve the next local occurrence");
}

/** Keep active receipts until they settle; pruning must never erase an admitted run. */
export function appendOccurrence(history: ScheduleOccurrence[], next: ScheduleOccurrence) {
	const retained = [...history, next].sort((a, b) => a.startedAt - b.startedAt);
	const settled = (item: ScheduleOccurrence) =>
		item.id !== next.id && item.status !== "prepared" && item.status !== "running";
	while (retained.filter((item) => item.taskId === next.taskId).length > 100) {
		const at = retained.findIndex((item) => item.taskId === next.taskId && settled(item));
		if (at < 0) throw new Error("Schedule history capacity is occupied by active runs");
		retained.splice(at, 1);
	}
	while (retained.length > 1000) {
		const at = retained.findIndex(settled);
		if (at < 0) throw new Error("Schedule history capacity is occupied by active runs");
		retained.splice(at, 1);
	}
	return retained;
}
