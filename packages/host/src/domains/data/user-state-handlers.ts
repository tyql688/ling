import { userStateProcedures } from "@ling/contracts/user-state-procedures";
import type { UserStateChange } from "@ling/contracts/user-state";
import type { HostDatabase } from "../../storage/database";
import type { HostEventPublisher } from "../../transport/event-bus";
import type { HostDomain } from "../../transport/host-domain";
import { createUserStateStore } from "./user-state-store";

export function createUserStateDomain({
	database,
	events,
}: {
	database: HostDatabase;
	events: HostEventPublisher;
}): HostDomain {
	const store = createUserStateStore(database);
	const publish = (change: UserStateChange) => {
		// Reviewed-cache eviction is authoritative; refresh its bounded snapshot after a change.
		const published = change.mutations?.some((value) => value.type === "reviewMark")
			? { ...change, mutations: null }
			: change;
		if (published.mutations === null || published.mutations.length > 0)
			events.broadcast(userStateProcedures.onChanged.channel, published);
		return published;
	};
	const release = database.subscribeSessionDeletion(() => publish({ revision: store.revision(), mutations: null }));
	return {
		handlers: {
			[userStateProcedures.get.channel]: async () => store.snapshot(),
			[userStateProcedures.update.channel]: async (_context, mutations) => publish(store.update(mutations)),
			[userStateProcedures.importLegacy.channel]: async (_context, request) => publish(store.importLegacy(request)),
		},
		dispose: async () => {
			release();
		},
	};
}
