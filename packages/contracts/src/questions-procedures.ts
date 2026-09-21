import { z } from "zod";
import { argumentsOf, event, request, returns } from "./procedure";
import type { QuestionRecord } from "./questions";
import { sessionRefSchema, type SessionRef } from "./session-ref";

const retrySchema = z.strictObject({ ref: sessionRefSchema, id: z.string().min(1).max(200) });

export const questionsProcedures = {
	list: request(
		"questions:list",
		argumentsOf((args): [SessionRef] => [sessionRefSchema.parse(args[0])]),
		returns<QuestionRecord[]>(),
	),
	retry: request(
		"questions:retry",
		argumentsOf((args): [z.infer<typeof retrySchema>] => [retrySchema.parse(args[0])]),
		returns<void>(),
	),
	onChanged: event("questions:changed", returns<SessionRef | null>()),
};
