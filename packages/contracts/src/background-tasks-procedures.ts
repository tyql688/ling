import type { z } from "zod";
import {
	backgroundJobIdSchema,
	backgroundReadInputSchema,
	backgroundStartInputSchema,
	type BackgroundJob,
	type BackgroundOutput,
} from "./background-tasks";
import { argumentsOf, event, request, returns } from "./procedure";
import { sessionRefSchema, type SessionRef } from "./session-ref";

const startSchema = backgroundStartInputSchema.extend({ ref: sessionRefSchema });
const readSchema = backgroundReadInputSchema.extend({ ref: sessionRefSchema });
const stopSchema = backgroundJobIdSchema.extend({ ref: sessionRefSchema });

export const backgroundTasksProcedures = {
	list: request(
		"backgroundTasks:list",
		argumentsOf((args): [SessionRef] => [sessionRefSchema.parse(args[0])]),
		returns<BackgroundJob[]>(),
	),
	start: request(
		"backgroundTasks:start",
		argumentsOf((args): [z.infer<typeof startSchema>] => [startSchema.parse(args[0])]),
		returns<BackgroundJob>(),
	),
	read: request(
		"backgroundTasks:read",
		argumentsOf((args): [z.infer<typeof readSchema>] => [readSchema.parse(args[0])]),
		returns<BackgroundOutput>(),
	),
	stop: request(
		"backgroundTasks:stop",
		argumentsOf((args): [z.infer<typeof stopSchema>] => [stopSchema.parse(args[0])]),
		returns<BackgroundJob>(),
	),
	onChanged: event("backgroundTasks:changed", returns<SessionRef | null>()),
};
