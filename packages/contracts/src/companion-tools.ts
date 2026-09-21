import { z } from "zod";
import { backgroundJobIdSchema, backgroundReadInputSchema, backgroundStartInputSchema } from "./background-tasks";
import { UI_LANGUAGES } from "./application";
import { questionIdSchema, questionsInputSchema } from "./questions";
import { scheduleSchema, scheduleTaskInputSchema } from "./schedules";

/**
 * The schedule as the agent writes it: one flat object keyed by a string enum. Several providers
 * mishandle `oneOf` branches with constant discriminators, so the exact union is applied after parsing.
 */
const agentScheduleSchema = z
	.object({
		kind: z.enum(["once", "interval", "calendar"]),
		at: z.number().optional().describe("once: run time in epoch milliseconds"),
		minutes: z.number().int().optional().describe("interval: minutes between runs, at least 5"),
		anchor: z.number().optional().describe("interval: epoch milliseconds the interval counts from; defaults to now"),
		time: z.string().optional().describe("calendar: local time as HH:MM"),
		timeZone: z.string().optional().describe("calendar: IANA time zone"),
		days: z.array(z.number().int()).optional().describe("calendar: weekdays to run on, 0 is Sunday"),
	})
	.transform(({ kind, at, minutes, anchor, time, timeZone, days }) =>
		kind === "once"
			? { kind, at }
			: kind === "interval"
				? { kind, minutes, anchor: anchor ?? Date.now() }
				: { kind, time, timeZone, days },
	)
	.pipe(scheduleSchema);

/** Agent tools implemented by Host features; the Pi worker registers them and forwards each call. */
export const companionTools = {
	ask_user: {
		feature: "questions",
		description:
			"Ask for missing information and wait. Every question accepts a custom answer. Never treat skip as approval.",
		input: questionsInputSchema,
	},
	ask_user_async: {
		feature: "questions",
		description:
			"Ask without blocking independent work. The explicit answer is delivered into this conversation. Check question_result before depending on it; pending, skipped and interrupted are not answers.",
		input: questionsInputSchema,
	},
	question_result: {
		feature: "questions",
		description:
			"Read an explicit asynchronous answer, including retained results after restart. Pending or interrupted is not an answer.",
		input: questionIdSchema,
	},
	background_start: {
		feature: "background-tasks",
		description:
			"Run a non-interactive shell command in this project with bounded retained output. Returns a task ID immediately. stdin is closed; use background_read to read output and background_stop to cancel. Default timeout: one hour.",
		input: backgroundStartInputSchema,
	},
	background_list: {
		feature: "background-tasks",
		description: "List this session's background tasks, including exit status and interrupted history.",
		input: z.object({}),
	},
	background_read: {
		feature: "background-tasks",
		description:
			"Read output using your own byte offset. GUI reads do not consume agent output. At most 64 KiB per call; retained logs are capped at 2 MiB.",
		input: backgroundReadInputSchema,
	},
	background_stop: {
		feature: "background-tasks",
		description: "Stop a task owned by this session and confirm process cleanup.",
		input: backgroundJobIdSchema,
	},
	schedule_list: {
		feature: "schedules",
		description:
			"List configured scheduled tasks and recent outcomes. Pausing future triggers is separate from stopping a running occurrence.",
		input: z.object({}),
	},
	schedule_create: {
		feature: "schedules",
		description:
			"Create a scheduled task only on explicit user request. Waits for user confirmation, then returns created after saving or cancelled after rejection. Use an opened project cwd and an IANA time zone for calendar schedules. Set language to match the conversation for the confirmation screen.",
		input: scheduleTaskInputSchema.extend({
			schedule: agentScheduleSchema,
			sessionId: scheduleTaskInputSchema.shape.sessionId
				.default(null)
				.describe("Conversation to continue; omit for a new conversation each time"),
			model: scheduleTaskInputSchema.shape.model.default(null).describe("Omit to follow the project model"),
			thinking: scheduleTaskInputSchema.shape.thinking.default(null).describe("Omit to follow settings"),
			missed: scheduleTaskInputSchema.shape.missed.default("skip"),
			notifications: scheduleTaskInputSchema.shape.notifications.default("attention"),
			language: z.enum(UI_LANGUAGES).optional(),
		}),
	},
} satisfies Record<
	string,
	{ feature: "questions" | "background-tasks" | "schedules"; description: string; input: z.ZodType }
>;
export type CompanionToolName = keyof typeof companionTools;

/** The JSON schema Pi shows the model for a tool; inputs are parsed again with the full schema on the Host. */
export function companionToolParameters(name: CompanionToolName): Record<string, unknown> {
	return z.toJSONSchema(companionTools[name].input, { io: "input", unrepresentable: "any" });
}
