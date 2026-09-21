import { argumentsOf, noArguments, request, returns } from "./procedure";
import type {
	GlobalInstructionFile,
	GlobalInstructionKind,
	GlobalInstructionLocation,
	GlobalInstructionSaveRequest,
} from "./global-instructions";
import * as schemas from "./global-instructions-requests";
export const globalInstructionsProcedures = {
	read: request(
		"global-instructions:read",
		argumentsOf<[kind: GlobalInstructionKind]>((args) => [schemas.kindSchema.parse(args[0])]),
		returns<GlobalInstructionFile>(),
	),
	save: request(
		"global-instructions:save",
		argumentsOf<[request: GlobalInstructionSaveRequest]>((args) => [schemas.saveRequestSchema.parse(args[0])]),
		returns<GlobalInstructionFile>(),
	),
	reveal: request(
		"global-instructions:reveal",
		argumentsOf<[kind: GlobalInstructionKind]>((args) => [schemas.kindSchema.parse(args[0])]),
		returns<GlobalInstructionLocation>(),
	),
	openDir: request("global-instructions:openDir", noArguments, returns<{ dir: string }>()),
};
