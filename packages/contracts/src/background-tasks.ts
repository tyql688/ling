import { z } from "zod";
import { sessionRefSchema } from "./session-ref";

const backgroundJobSchema = z.object({
	id: z.uuid(),
	ref: sessionRefSchema,
	command: z.string(),
	status: z.enum(["running", "stopping", "completed", "failed", "cancelled", "interrupted"]),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
	exitCode: z.number().nullable(),
	error: z.string().nullable(),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;
export const backgroundJobsSchema = z.array(backgroundJobSchema).max(100);
export const backgroundStartInputSchema = z.object({
	command: z.string().trim().min(1).max(32_768),
	timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
});
export const backgroundReadInputSchema = z.object({ id: z.uuid(), offset: z.number().int().nonnegative().default(0) });
export const backgroundJobIdSchema = z.object({ id: z.uuid() });
export interface BackgroundOutput {
	process: BackgroundJob;
	text: string;
	offset: number;
	truncated: boolean;
}
export const activeJobStatuses: ReadonlySet<BackgroundJob["status"]> = new Set(["running", "stopping"]);
