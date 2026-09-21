import { z } from "zod";
import { thinkingLevelSchema } from "./companions";
import { portableAbsolutePathSchema } from "./path-validation";

const zone = z
	.string()
	.min(1)
	.max(100)
	.refine((value) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: value });
			return true;
		} catch {
			return false;
		}
	}, "Use a valid IANA time zone");
export const scheduleSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("once"), at: z.number().positive() }),
	z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(525_600), anchor: z.number() }),
	z.object({
		kind: z.literal("calendar"),
		time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
		timeZone: zone,
		days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
	}),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

/** Describes when a schedule runs; `word` supplies the translated fixed phrases. */
export function describeSchedule(
	schedule: Schedule,
	locale: string | undefined,
	word: (key: "once" | "everyMinutes" | "everyDay" | "weekdays", count?: number) => string,
): string {
	if (schedule.kind === "once")
		return `${word("once")} · ${new Date(schedule.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}`;
	if (schedule.kind === "interval") return word("everyMinutes", schedule.minutes);
	const days = [...new Set(schedule.days)].sort();
	// The schedule numbers Sunday as zero; format a known UTC week independent of the host zone.
	const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
	const repeat =
		days.length === 7
			? word("everyDay")
			: days.join() === "1,2,3,4,5"
				? word("weekdays")
				: days.map((day) => weekday.format(new Date(Date.UTC(2023, 0, 1 + day)))).join(" · ");
	return `${repeat} ${schedule.time}`;
}

export const scheduleTaskInputSchema = z.object({
	title: z.string().trim().min(1).max(200),
	prompt: z.string().trim().min(1).max(32_768),
	cwd: portableAbsolutePathSchema("Project path"),
	sessionId: z.string().min(1).nullable(),
	schedule: scheduleSchema,
	model: z.object({ provider: z.string().min(1), id: z.string().min(1) }).nullable(),
	thinking: thinkingLevelSchema.nullable(),
	missed: z.enum(["skip", "latest"]),
	notifications: z.enum(["all", "attention", "none"]),
});
export type ScheduleTaskInput = z.infer<typeof scheduleTaskInputSchema>;
const scheduleTaskSchema = scheduleTaskInputSchema.extend({
	id: z.uuid(),
	revision: z.number().int(),
	status: z.enum(["active", "paused", "completed"]),
	nextAt: z.number().nullable(),
	updatedAt: z.number(),
});
export type ScheduleTask = z.infer<typeof scheduleTaskSchema>;
const scheduleOccurrenceSchema = z.object({
	id: z.uuid(),
	taskId: z.string(),
	taskRevision: z.number(),
	scheduledAt: z.number(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
	runId: z.string().nullable(),
	sessionId: z.string().nullable(),
	cwd: z.string(),
	status: z.enum(["prepared", "running", "completed", "failed", "cancelled", "interrupted", "skipped"]),
	error: z.string().nullable(),
	summary: z.string().max(512),
	unread: z.boolean(),
});
export type ScheduleOccurrence = z.infer<typeof scheduleOccurrenceSchema>;
export const schedulesStateSchema = z.object({
	tasks: z.array(scheduleTaskSchema).max(100),
	history: z.array(scheduleOccurrenceSchema).max(1000),
});
export type SchedulesSnapshot = z.infer<typeof schedulesStateSchema> & { error: string | null };
export interface ScheduleModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}
export const scheduleSaveSchema = z.object({
	id: z.uuid().nullable(),
	expectedRevision: z.number().int().nullable(),
	task: scheduleTaskInputSchema,
});
export const scheduleStatusSchema = z.object({
	id: z.uuid(),
	status: z.enum(["active", "paused"]),
	revision: z.number().int(),
});
export const scheduleTargetSchema = z.object({ id: z.uuid(), revision: z.number().int() });
export const scheduleIdSchema = z.object({ id: z.uuid() });
