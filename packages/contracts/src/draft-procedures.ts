import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import {
	draftKeySchema,
	resolveDraftConflictSchema,
	writeDraftSchema,
	type DraftEvent,
	type DraftSnapshot,
	type ResolveDraftConflict,
	type StoredDraft,
	type WriteDraft,
	type WriteDraftResult,
} from "./draft";
export const draftProcedures = {
	list: request("draft:list", noArguments, returns<DraftSnapshot>()),
	get: request(
		"draft:get",
		argumentsOf<[key: string]>((args) => [draftKeySchema.parse(args[0])]),
		returns<StoredDraft>(),
	),
	write: request(
		"draft:write",
		argumentsOf<[value: WriteDraft]>((args) => [writeDraftSchema.parse(args[0])]),
		returns<WriteDraftResult>(),
	),
	resolveConflict: request(
		"draft:resolveConflict",
		argumentsOf<[value: ResolveDraftConflict]>((args) => [resolveDraftConflictSchema.parse(args[0])]),
		returns<WriteDraftResult | null>(),
	),
	onChanged: event("draft:changed", returns<DraftEvent>()),
};
