import { z } from "zod";
import {
	DIAGNOSTIC_LOG_PAGE_MAX,
	DIAGNOSTIC_LOG_TEXT_MAX_CHARS,
	type DiagnosticLogPage,
	type DiagnosticLogQuery,
	type DiagnosticProcess,
} from "./diagnostics";
import { argumentsOf, noArguments, request, returns } from "./procedure";

const label = z.string().min(1).max(64);
const logQuerySchema = z.strictObject({
	beforeId: z.number().int().positive().optional(),
	afterId: z.number().int().nonnegative().optional(),
	limit: z.number().int().positive().max(DIAGNOSTIC_LOG_PAGE_MAX).optional(),
	levels: z
		.array(z.enum(["info", "warn", "error"]))
		.max(3)
		.optional(),
	process: label.optional(),
	component: label.optional(),
	sessionId: z.string().min(1).max(128).optional(),
	text: z.string().min(1).max(DIAGNOSTIC_LOG_TEXT_MAX_CHARS).optional(),
});

export const diagnosticsProcedures = {
	logs: request(
		"diagnostics:logs",
		argumentsOf<[query: DiagnosticLogQuery]>((args) => [
			Object.fromEntries(
				Object.entries(logQuerySchema.parse(args[0] ?? {})).filter(([, value]) => value !== undefined),
			) as DiagnosticLogQuery,
		]),
		returns<DiagnosticLogPage>(),
	),
	processes: request("diagnostics:processes", noArguments, returns<DiagnosticProcess[]>()),
};
