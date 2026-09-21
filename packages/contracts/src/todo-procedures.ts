import { z } from "zod";
import { UI_LANGUAGES } from "./application";
import { argumentsOf, request, returns } from "./procedure";
import { sessionRefSchema, type SessionRef } from "./session-ref";
import type { TodoSnapshot } from "./todo";

const reviewSchema = z.strictObject({
	ref: sessionRefSchema,
	requestId: z.string().min(1).max(200),
	language: z.enum(UI_LANGUAGES).optional(),
});

export const todoProcedures = {
	snapshot: request(
		"todo:snapshot",
		argumentsOf((args): [SessionRef] => [sessionRefSchema.parse(args[0])]),
		returns<TodoSnapshot>(),
	),
	review: request(
		"todo:review",
		argumentsOf((args): [z.infer<typeof reviewSchema>] => [reviewSchema.parse(args[0])]),
		returns<void>(),
	),
};
