import type { SessionCatalogStore } from "./session-catalog";
import type { ManagedSessionManager } from "@ling/host/domains/sessions/manager/session-manager";
import { createLogger } from "@ling/core/logger";
import { requestCancelled } from "@ling/core/ling-error";
import { cachedSessionSummariesFromCatalog } from "@ling/host/domains/sessions/session-catalog-document";

const log = createLogger("session-list");

type SessionListResult = Awaited<ReturnType<ManagedSessionManager["listAllSessions"]>>;

export function createSessionListCache(
	{ listAllSessions }: Pick<ManagedSessionManager, "listAllSessions">,
	catalog: Pick<SessionCatalogStore, "snapshot">,
) {
	/** React development effects can request the same startup list concurrently. */
	const sessionListsInFlight = new Map<string, Promise<SessionListResult>>();
	let stopping = false;
	let revision = 0;
	let disposal: Promise<void> | null = null;

	async function loadSessionsFromCatalogCache(projectCwds: string[]): Promise<SessionListResult> {
		const startedAt = performance.now();
		const snapshot = await catalog.snapshot();
		const cached = cachedSessionSummariesFromCatalog(snapshot);
		const sessions = await listAllSessions(projectCwds, cached);
		log.info(`session list ready count=${sessions.length} durationMs=${Math.round(performance.now() - startedAt)}`);
		return sessions;
	}

	/** Reuses one physical scan for concurrent requests over the same open-project snapshot. */
	function listSessionsFromCatalogCache(projectCwds: readonly string[]): Promise<SessionListResult> {
		if (stopping) return Promise.reject(requestCancelled("The session list is shutting down."));
		const projects = [...projectCwds];
		const key = JSON.stringify([revision, projects]);
		const active = sessionListsInFlight.get(key);
		if (active) return active;

		const request = loadSessionsFromCatalogCache(projects);
		const tracked = request.finally(() => {
			if (sessionListsInFlight.get(key) === tracked) sessionListsInFlight.delete(key);
		});
		sessionListsInFlight.set(key, tracked);
		return tracked;
	}
	return {
		listSessionsFromCatalogCache,
		invalidate() {
			// Keep older scans tracked for shutdown, but never reuse them after a catalog mutation.
			revision += 1;
		},
		prepareShutdown() {
			stopping = true;
		},
		dispose(): Promise<void> {
			if (disposal) return disposal;
			stopping = true;
			// Requests retain their own failure result; shutdown waits for their scan slots to clear.
			disposal = Promise.allSettled([...sessionListsInFlight.values()]).then(() => undefined);
			return disposal;
		},
	};
}
