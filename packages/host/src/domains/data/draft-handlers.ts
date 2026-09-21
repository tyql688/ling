import type { DraftEvent, WriteDraftResult } from "@ling/contracts/draft";
import { draftProcedures } from "@ling/contracts/draft-procedures";
import type { HostDatabase } from "../../storage/database";
import type { HostEventPublisher } from "../../transport/event-bus";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import { createDraftStore } from "./draft-store";

export function createDraftDomain({
	database,
	events,
}: {
	database: HostDatabase;
	events: HostEventPublisher;
}): HostDomain {
	const drafts = createDraftStore(database);
	function publish(event: DraftEvent) {
		events.broadcast(draftProcedures.onChanged.channel, event);
	}
	function written(result: WriteDraftResult) {
		if (result.status === "saved") publish({ type: "updated", current: result.current });
		else if (result.recovery !== null) publish({ type: "conflictsChanged" });
		return result;
	}
	const handlers: HostHandlers = {
		[draftProcedures.list.channel]: async () => drafts.list(),
		[draftProcedures.get.channel]: async (_context, key) => drafts.get(key),
		[draftProcedures.write.channel]: async (_context, request) => written(drafts.write(request)),
		[draftProcedures.resolveConflict.channel]: async (_context, request) => {
			const result = drafts.resolveConflict(request);
			if (result !== null) written(result);
			publish({ type: "conflictsChanged" });
			return result;
		},
	};
	const release = database.subscribeSessionDeletion(() => publish({ type: "conflictsChanged" }));
	return {
		handlers,
		dispose: async () => {
			release();
		},
	};
}
