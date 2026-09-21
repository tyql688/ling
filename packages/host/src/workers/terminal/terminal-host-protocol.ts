import { TERMINAL_OUTPUT_CHUNK_MAX_CHARS } from "@ling/contracts/terminal";
import {
	terminalAckShape,
	terminalDimensionsShape,
	terminalInputDataSchema,
	terminalRefShape,
} from "@ling/contracts/terminal-validation";
import { absolutePathSchema } from "@ling/core/paths";
import { z } from "zod";

/** One MiB accommodates UTF-8 terminal chunks and shell arguments while bounding each IPC frame. */
export const TERMINAL_HOST_FRAME_MAX_BYTES = 1024 * 1024;

export const terminalHostRequestSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("create"),
		...terminalRefShape,
		cwd: absolutePathSchema("Terminal cwd"),
		shellPath: absolutePathSchema("Terminal shell"),
		args: z.array(z.string()),
		...terminalDimensionsShape,
	}),
	z.strictObject({ kind: z.literal("close"), ...terminalRefShape }),
	z.strictObject({ kind: z.literal("dispose") }),
]);
export const terminalHostInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("input"), ...terminalRefShape, data: terminalInputDataSchema }),
	z.strictObject({ kind: z.literal("resize"), ...terminalRefShape, ...terminalDimensionsShape }),
	z.strictObject({ kind: z.literal("ack"), ...terminalRefShape, ...terminalAckShape }),
]);
const terminalExitSchema = z.strictObject({
	exitCode: z.number().int().nullable(),
	signal: z.number().int().nullable(),
	reason: z.enum(["process", "killed", "hostLost"]),
});
export const terminalHostEventSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("idle") }),
	z
		.strictObject({
			kind: z.literal("output"),
			...terminalRefShape,
			...terminalAckShape,
			data: z.string().min(1).max(TERMINAL_OUTPUT_CHUNK_MAX_CHARS),
		})
		.refine((value) => value.ackUnits === value.data.length, "Terminal acknowledgement must match the output size"),
	z.strictObject({ kind: z.literal("exit"), ...terminalRefShape, exit: terminalExitSchema }),
]);
/** ConPTY may return pid zero while the PTY works. Non-create commands have no process id. */
export const terminalHostPidSchema = z.number().int().nonnegative().nullable();
export type TerminalHostRequest = z.infer<typeof terminalHostRequestSchema>;
export type TerminalHostInput = z.infer<typeof terminalHostInputSchema>;
export type TerminalHostMessage = z.infer<typeof terminalHostEventSchema>;

/** A recycled terminal id never aliases a prior worker generation. */
export function terminalKey(terminalId: string, generation: number): string {
	return `${generation}:${terminalId}`;
}
