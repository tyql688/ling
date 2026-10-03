import { z } from "zod";

/** Trust extensions can ask questions before a project or session runtime exists. */
export const projectTrustPromptSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("select"),
		title: z.string().max(65_536),
		options: z.array(z.string().max(4096)).max(256),
	}),
	z.strictObject({ kind: z.literal("input"), title: z.string().max(65_536), placeholder: z.string().max(4096) }),
	z.strictObject({ kind: z.literal("confirm"), title: z.string().max(65_536), message: z.string().max(65_536) }),
	z.strictObject({ kind: z.literal("notify"), title: z.string().max(65_536) }),
]);
export type ProjectTrustPrompt = z.infer<typeof projectTrustPromptSchema>;
