import { z } from "zod";
import { boundedString, strictObject } from "./schema-primitives";
import {
	GLOBAL_INSTRUCTION_KINDS,
	GLOBAL_INSTRUCTION_MAX_BYTES,
	type GlobalInstructionSaveRequest,
} from "./global-instructions";
export const kindSchema = z.enum(GLOBAL_INSTRUCTION_KINDS);
export const saveRequestSchema: z.ZodType<GlobalInstructionSaveRequest> = strictObject({
	kind: kindSchema,
	// UTF-8 bytes bound disk writes, including multi-byte pasted Markdown.
	content: boundedString(GLOBAL_INSTRUCTION_MAX_BYTES, "Global instruction content").refine(
		(value) => new TextEncoder().encode(value).byteLength <= GLOBAL_INSTRUCTION_MAX_BYTES,
		{ message: "Global instruction content exceeds the size limit" },
	),
});
