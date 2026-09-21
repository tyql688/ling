import { argumentsOf, event, request, returns } from "./procedure";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
import type {
	TerminalAckRequest,
	TerminalAttachResult,
	TerminalCreateRequest,
	TerminalEvent,
	TerminalInputRequest,
	TerminalProfilesSnapshot,
	TerminalRefRequest,
	TerminalResizeRequest,
	TerminalSnapshot,
} from "./terminal";
import { createTerminalRequestSchemas } from "./terminal-validation";
export function createTerminalProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const schemas = createTerminalRequestSchemas(paths.absolute("Project path"));
	return {
		listProfiles: request(
			"terminal:listProfiles",
			argumentsOf<[]>((args) => {
				schemas.emptyTerminalRequestSchema.parse(args[0]);
				return [];
			}),
			returns<TerminalProfilesSnapshot>(),
		),
		list: request(
			"terminal:list",
			argumentsOf<[]>((args) => {
				schemas.emptyTerminalRequestSchema.parse(args[0]);
				return [];
			}),
			returns<TerminalSnapshot[]>(),
		),
		create: request(
			"terminal:create",
			argumentsOf<[request: TerminalCreateRequest]>((args) => [schemas.terminalCreateRequestSchema.parse(args[0])]),
			returns<TerminalSnapshot>(),
		),
		attach: request(
			"terminal:attach",
			argumentsOf<[request: TerminalRefRequest]>((args) => [schemas.terminalRefRequestSchema.parse(args[0])]),
			returns<TerminalAttachResult>(),
		),
		input: request(
			"terminal:input",
			argumentsOf<[request: TerminalInputRequest]>((args) => [schemas.terminalInputRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		resize: request(
			"terminal:resize",
			argumentsOf<[request: TerminalResizeRequest]>((args) => [schemas.terminalResizeRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		ack: request(
			"terminal:ack",
			argumentsOf<[request: TerminalAckRequest]>((args) => [schemas.terminalAckRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		close: request(
			"terminal:close",
			argumentsOf<[request: TerminalRefRequest]>((args) => [schemas.terminalRefRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		onEvent: event("terminal:event", returns<TerminalEvent>()),
	};
}
export const terminalProcedures = createTerminalProcedures();
