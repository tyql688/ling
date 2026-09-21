import { z } from "zod";
import { controlPathSchema, controlIdSchema as runtimeIdSchema } from "./control-schemas";
import { piMethod } from "./method";
import type { PiWorkerRuntimeBootstrap } from "./protocol";
import { command, LIFECYCLE_REQUEST_TIMEOUT_MS } from "./request-policy";
import { runtimeBootstrapSchema } from "./runtime-operation-results";
import { idSchema as identifierSchema, fieldSchema as textSchema } from "./runtime-payload-schemas";
const finiteTimestampSchema = z.number().int().nonnegative();
export const piLifecycleMethods = {
	"runtime.create": piMethod(
		z.strictObject({
			runtimeId: runtimeIdSchema,
			cwd: controlPathSchema,
			model: z.strictObject({ provider: identifierSchema, id: identifierSchema }).optional(),
			thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
		}),
		(value) => runtimeBootstrapSchema.parse(value) as PiWorkerRuntimeBootstrap,
		command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
	),
	"runtime.resume": piMethod(
		z.strictObject({
			runtimeId: runtimeIdSchema,
			cwd: controlPathSchema,
			sessionFilePath: controlPathSchema,
			createdAt: finiteTimestampSchema,
		}),
		(value) => runtimeBootstrapSchema.parse(value) as PiWorkerRuntimeBootstrap,
		command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
	),
	"runtime.fork": piMethod(
		z.strictObject({
			runtimeId: runtimeIdSchema,
			cwd: controlPathSchema,
			sourceSessionFilePath: controlPathSchema,
			entryId: identifierSchema,
			title: textSchema,
		}),
		(value) => runtimeBootstrapSchema.parse(value) as PiWorkerRuntimeBootstrap,
		command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
	),
};
