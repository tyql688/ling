import { z } from "zod";
import { sessionRefSchema } from "./session-ref";

export const questionsInputSchema = z
	.object({
		title: z.string().min(1).max(300),
		body: z.string().max(16_000).optional(),
		questions: z
			.array(
				z.object({
					id: z.string().min(1).max(100),
					title: z.string().min(1).max(2000),
					multiple: z
						.boolean()
						.optional()
						.describe(
							"Allow selecting several options when true; otherwise at most one. Users can add text in either mode.",
						),
					options: z
						.array(
							z.object({
								id: z.string().min(1).max(100),
								label: z.string().min(1).max(400),
								description: z.string().max(1000).optional(),
							}),
						)
						.max(12)
						.optional(),
				}),
			)
			.min(1)
			.max(8),
	})
	.superRefine(({ questions }, context) => {
		const questionIds = new Set<string>();
		for (const [index, question] of questions.entries()) {
			if (questionIds.has(question.id))
				context.addIssue({ code: "custom", path: ["questions", index, "id"], message: "Question IDs must be unique" });
			questionIds.add(question.id);
			const optionIds = new Set<string>();
			for (const [optionIndex, option] of (question.options ?? []).entries()) {
				if (optionIds.has(option.id))
					context.addIssue({
						code: "custom",
						path: ["questions", index, "options", optionIndex, "id"],
						message: "Option IDs must be unique within a question",
					});
				optionIds.add(option.id);
			}
		}
	});
export type QuestionsInput = z.infer<typeof questionsInputSchema>;
export const questionRecordSchema = z.object({
	id: z.string(),
	ref: sessionRefSchema,
	title: z.string(),
	questions: questionsInputSchema.shape.questions,
	status: z.enum(["pending", "answered", "skipped", "interrupted"]),
	answer: z
		.object({
			status: z.enum(["answered", "skipped"]),
			answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), text: z.string() })),
		})
		.nullable(),
	delivery: z.enum(["none", "sending", "delivered", "failed"]),
	error: z.string().nullable(),
	createdAt: z.number(),
});
export type QuestionRecord = z.infer<typeof questionRecordSchema>;
export const questionIdSchema = z.object({ id: z.string().min(1).max(200) });
