import { DATA_HEALTH_ISSUE_LIMIT, type DataStoreHealth, type DataStoreIssue } from "@ling/contracts/data-store";
import { dataStoreProcedures } from "@ling/contracts/data-store-procedures";
import type { HostDatabase } from "../../storage/database";
import type { HostEventPublisher } from "../../transport/event-bus";
import type { HostDomain } from "../../transport/host-domain";

export function createDataDomain({
	database,
	events,
	inspectSources,
	retrySources,
}: {
	database: HostDatabase;
	events: HostEventPublisher;
	inspectSources(): Promise<DataStoreIssue[]>;
	retrySources(): Promise<DataStoreIssue[]>;
}): HostDomain {
	async function status(retry = false): Promise<DataStoreHealth> {
		const health = retry ? database.retry() : database.health();
		if (health.status === "unavailable") return health;
		const issues = retry ? await retrySources() : await inspectSources();
		const current = database.health();
		const combined = new Map([...current.issues, ...issues].map((issue) => [issue.key, issue]));
		return {
			...current,
			status: current.status === "unavailable" ? "unavailable" : combined.size > 0 ? "degraded" : "ready",
			issues: [...combined.values()].slice(0, DATA_HEALTH_ISSUE_LIMIT),
			omittedIssues: current.omittedIssues + Math.max(0, combined.size - DATA_HEALTH_ISSUE_LIMIT),
		};
	}
	const release = database.subscribe(() => events.broadcast(dataStoreProcedures.onChanged.channel, null));
	return {
		handlers: {
			[dataStoreProcedures.status.channel]: async () => status(),
			[dataStoreProcedures.retry.channel]: async () => status(true),
		},
		dispose: async () => {
			release();
		},
	};
}
