import { portableAbsolutePathSchema } from "./path-validation";
import { z } from "zod";
import { boundedString, safeIdSchema, controlFreeString, strictObject } from "./schema-primitives";
import {
	TERMINAL_ID_MAX_CHARS,
	TERMINAL_PROFILE_ID_MAX_CHARS,
	TERMINAL_INPUT_MAX_CHARS,
	TERMINAL_MAX_COLUMNS,
	TERMINAL_MAX_ROWS,
	TERMINAL_OUTPUT_CHUNK_MAX_CHARS,
} from "./terminal";

export const terminalRefShape = {
	terminalId: safeIdSchema(TERMINAL_ID_MAX_CHARS, "Terminal id"),
	generation: z.number().int().positive(),
};
export const terminalDimensionsShape = {
	cols: z.number().int().min(2).max(TERMINAL_MAX_COLUMNS),
	rows: z.number().int().min(1).max(TERMINAL_MAX_ROWS),
};
export const terminalInputDataSchema = boundedString(TERMINAL_INPUT_MAX_CHARS, "Terminal input").min(1);
export const terminalAckShape = {
	sequence: z.number().int().positive(),
	ackUnits: z.number().int().positive().max(TERMINAL_OUTPUT_CHUNK_MAX_CHARS),
};

/** Native hosts supply their path rules here; all request fields keep one definition. */
export function createTerminalRequestSchemas(projectPathSchema = portableAbsolutePathSchema("Project path")) {
	const emptyTerminalRequestSchema = z.undefined();

	const terminalRefRequestSchema = strictObject({
		...terminalRefShape,
	});

	const terminalCreateRequestSchema = strictObject({
		cwd: projectPathSchema,
		...terminalDimensionsShape,
		/** Omission uses the configured default; null uses the detected system suggestion. */
		profileId: controlFreeString(TERMINAL_PROFILE_ID_MAX_CHARS, "Terminal profile id").nullable().optional(),
	});

	const terminalInputRequestSchema = strictObject({
		...terminalRefShape,
		data: terminalInputDataSchema,
	});

	const terminalResizeRequestSchema = strictObject({
		...terminalRefShape,
		...terminalDimensionsShape,
	});

	const terminalAckRequestSchema = strictObject({
		...terminalRefShape,
		...terminalAckShape,
	});

	return {
		emptyTerminalRequestSchema,
		terminalRefRequestSchema,
		terminalCreateRequestSchema,
		terminalInputRequestSchema,
		terminalResizeRequestSchema,
		terminalAckRequestSchema,
	};
}
