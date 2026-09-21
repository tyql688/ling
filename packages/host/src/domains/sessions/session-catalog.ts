import type { DatasetStoreStatus } from "@ling/contracts/dataset-status";
import { errorCode } from "@ling/contracts/ling-error";
import type { SessionSummary } from "@ling/contracts/session";
import { sessionKey, toSessionRef, type SessionRef } from "@ling/contracts/session-ref";
import { requestCancelled } from "@ling/core/ling-error";
import { readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import {
	datasetStoreStatusFromError,
	isRecoverableDatasetReadError,
	parseDatasetJson,
} from "@ling/host/storage/dataset-envelope";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { HostDatabase } from "../../storage/database";
import {
	cachedSummaryFromSource,
	catalogFingerprint,
	cloneCatalogEntries,
	MAX_SESSION_CATALOG_BYTES,
	MAX_SESSION_CATALOG_ENTRIES,
	parseSessionCatalogDocument,
	parseSessionCatalogEntries,
	serializeSessionCatalog,
	SESSION_CATALOG_DATASET_ID,
	type SessionCatalogEntry,
	type SessionCatalogSource,
} from "./session-catalog-document";

/**
 * Concurrency for checking whether session files still exist. 32 saturates SSD
 * throughput without opening thousands of fds on spinning or network disks.
 */
const FILE_EXISTENCE_CONCURRENCY = 32;

function reconcileSessionCatalog(
	catalog: readonly SessionCatalogEntry[],
	sessions: readonly SessionCatalogSource[],
	existingSessionFilePaths: ReadonlySet<string>,
): SessionCatalogEntry[] {
	const byKey = new Map(catalog.map((entry) => [sessionKey(entry.ref), entry]));
	const reconciled: SessionCatalogEntry[] = sessions.map((summary) => {
		const ref = toSessionRef(summary);
		const existing = byKey.get(sessionKey(ref));
		const cachedSummary = cachedSummaryFromSource(summary);
		return {
			ref,
			sessionFilePath: summary.sessionFilePath,
			...(existing?.archivedAt !== undefined ? { archivedAt: existing.archivedAt } : {}),
			...(existing?.pinnedAt !== undefined ? { pinnedAt: existing.pinnedAt } : {}),
			...(cachedSummary ? { cachedSummary } : {}),
		};
	});
	const liveKeys = new Set(sessions.map((summary) => sessionKey(toSessionRef(summary))));
	for (const entry of catalog) {
		if (liveKeys.has(sessionKey(entry.ref))) continue;
		if (existingSessionFilePaths.has(entry.sessionFilePath)) reconciled.push(entry);
	}
	return reconciled;
}

export function applyCatalogMetadata(
	sessions: readonly SessionSummary[],
	catalog: readonly SessionCatalogEntry[],
): SessionSummary[] {
	const byKey = new Map(catalog.map((entry) => [sessionKey(entry.ref), entry]));
	return sessions
		.map((summary) => {
			const metadata = byKey.get(sessionKey(toSessionRef(summary)));
			return {
				id: summary.id,
				cwd: summary.cwd,
				title: summary.title,
				createdAt: summary.createdAt,
				updatedAt: summary.updatedAt,
				messageCount: summary.messageCount,
				preview: summary.preview,
				...(summary.relation !== undefined ? { relation: summary.relation } : {}),
				...(summary.archivedAt !== undefined ? { archivedAt: summary.archivedAt } : {}),
				...(summary.pinnedAt !== undefined ? { pinnedAt: summary.pinnedAt } : {}),
				...(metadata?.archivedAt !== undefined ? { archivedAt: metadata.archivedAt } : {}),
				...(metadata?.pinnedAt !== undefined ? { pinnedAt: metadata.pinnedAt } : {}),
			} satisfies SessionSummary;
		})
		.sort(compareCatalogSummaries);
}

async function catalogFileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

export interface SessionCatalogStore {
	status(): Promise<SessionCatalogStoreStatus>;
	retryRead(): Promise<void>;
	snapshot(): Promise<SessionCatalogEntry[]>;
	retryPersistence(sessions: readonly SessionCatalogSource[]): Promise<void>;
	reconcile(sessions: readonly SessionCatalogSource[]): Promise<SessionCatalogEntry[]>;
	rebuild(sessions: readonly SessionCatalogSource[]): Promise<SessionCatalogEntry[]>;
	updateMetadata(
		sessions: readonly SessionCatalogSource[],
		ref: SessionRef,
		update: { archived?: boolean; pinned?: boolean },
	): Promise<SessionCatalogEntry[]>;
	remove(ref: SessionRef): Promise<void>;
	dispose(): Promise<void>;
}

type SessionCatalogStoreStatus =
	DatasetStoreStatus | { status: "degraded"; errorCode: "SESSION_CATALOG_PERSIST_FAILED" };

interface CatalogState {
	entries: SessionCatalogEntry[] | null;
	persistedFingerprint: string | null;
	load: Promise<void> | null;
	readError: Error | null;
	persistFailed: boolean;
	mutations: Promise<void>;
	removedKeys: Map<string, true>;
}

async function existingCatalogFilePaths(
	catalog: readonly SessionCatalogEntry[],
	sessions: readonly SessionCatalogSource[],
): Promise<Set<string>> {
	const liveKeys = new Set(sessions.map((summary) => sessionKey(toSessionRef(summary))));
	const candidates = [
		...new Set(catalog.filter((entry) => !liveKeys.has(sessionKey(entry.ref))).map((entry) => entry.sessionFilePath)),
	];
	const existing = new Set<string>();
	for (let start = 0; start < candidates.length; start += FILE_EXISTENCE_CONCURRENCY) {
		const batch = candidates.slice(start, start + FILE_EXISTENCE_CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (filePath) => ({ filePath, exists: await catalogFileExists(filePath) })),
		);
		for (const result of results) {
			if (result.exists) existing.add(result.filePath);
		}
	}
	return existing;
}

export function createSessionCatalogStore({
	userDataDir,
	database,
}: {
	userDataDir: string;
	database: HostDatabase;
}): SessionCatalogStore {
	const filePath = join(userDataDir, "ling-session-catalog.json");
	const state: CatalogState = {
		entries: null,
		persistedFingerprint: null,
		load: null,
		readError: null,
		persistFailed: false,
		mutations: Promise.resolve(),
		removedKeys: new Map(),
	};
	let disposal: Promise<void> | null = null;
	let disposed = false;

	function publishEntries(incoming: readonly SessionCatalogEntry[]) {
		// Previous catalog projections used the last metadata value for each durable session identity.
		const entries = [...new Map(incoming.map((entry) => [sessionKey(entry.ref), entry])).values()];
		serializeSessionCatalog(entries);
		database.transaction(() => {
			const remaining = new Map(
				database.all("SELECT cwd,session_id,session_file_path,summary FROM session_catalog").map((row) => {
					const parsed = z
						.object({
							cwd: z.string(),
							session_id: z.string(),
							session_file_path: z.string(),
							summary: z.string().nullable(),
						})
						.parse(row);
					return [sessionKey({ cwd: parsed.cwd, sessionId: parsed.session_id }), parsed];
				}),
			);
			for (const entry of entries) {
				const key = sessionKey(entry.ref);
				const previous = remaining.get(key);
				remaining.delete(key);
				const summary = entry.cachedSummary === undefined ? null : JSON.stringify(entry.cachedSummary);
				if (previous?.session_file_path !== entry.sessionFilePath || previous.summary !== summary)
					database.run(
						"INSERT INTO session_catalog(cwd,session_id,session_file_path,summary) VALUES(?,?,?,?) ON CONFLICT(cwd,session_id) DO UPDATE SET session_file_path=excluded.session_file_path,summary=excluded.summary",
						entry.ref.cwd,
						entry.ref.sessionId,
						entry.sessionFilePath,
						summary,
					);
				database.run(
					"INSERT INTO session_meta(cwd,session_id,pinned_at,archived_at) VALUES(?,?,?,?) ON CONFLICT(cwd,session_id) DO UPDATE SET pinned_at=excluded.pinned_at,archived_at=excluded.archived_at WHERE session_meta.pinned_at IS NOT excluded.pinned_at OR session_meta.archived_at IS NOT excluded.archived_at",
					entry.ref.cwd,
					entry.ref.sessionId,
					entry.pinnedAt ?? null,
					entry.archivedAt ?? null,
				);
			}
			for (const row of remaining.values())
				database.run("DELETE FROM session_catalog WHERE cwd=? AND session_id=?", row.cwd, row.session_id);
		});
	}
	async function readCatalogRows(): Promise<SessionCatalogEntry[]> {
		database.importLegacy({
			key: SESSION_CATALOG_DATASET_ID,
			source: filePath,
			read() {
				const contents = readUtf8FileSyncBounded(filePath, MAX_SESSION_CATALOG_BYTES);
				return contents === undefined ? [] : parseSessionCatalogDocument(contents).entries;
			},
			publish: publishEntries,
		});
		const rows = database.all(
			"SELECT c.cwd,c.session_id,c.session_file_path,c.summary,m.pinned_at,m.archived_at FROM session_catalog c LEFT JOIN session_meta m ON c.cwd=m.cwd AND c.session_id=m.session_id ORDER BY c.rowid LIMIT ?",
			MAX_SESSION_CATALOG_ENTRIES + 1,
		);
		return parseSessionCatalogEntries(
			rows.map((row) => ({
				ref: { cwd: row.cwd, sessionId: row.session_id },
				sessionFilePath: row.session_file_path,
				...(row.pinned_at === null ? {} : { pinnedAt: row.pinned_at }),
				...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
				...(row.summary === null
					? {}
					: { cachedSummary: parseDatasetJson(z.string().parse(row.summary), SESSION_CATALOG_DATASET_ID) }),
			})),
		);
	}

	function shutdownError() {
		return requestCancelled("The session catalog is shutting down.");
	}

	async function loadState(state: CatalogState): Promise<void> {
		if (state.entries) return;
		if (state.readError) throw state.readError;
		if (state.load) return state.load;

		const operation = readCatalogRows()
			.then((entries) => {
				state.entries = cloneCatalogEntries(entries);
				state.persistedFingerprint = catalogFingerprint(entries);
			})
			.catch((error: unknown) => {
				if (isRecoverableDatasetReadError(error)) state.readError = error;
				throw error;
			});
		const tracked = operation.finally(() => {
			if (state.load === tracked) state.load = null;
		});
		state.load = tracked;
		return tracked;
	}

	function enqueue<T>(operation: (state: CatalogState, filePath: string) => Promise<T>, retryRead = false): Promise<T> {
		if (disposed) return Promise.reject(shutdownError());
		const result = state.mutations.then(async () => {
			if (retryRead) state.readError = null;
			await loadState(state);
			return operation(state, filePath);
		});
		state.mutations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function persist(
		state: CatalogState,
		filePath: string,
		entries: readonly SessionCatalogEntry[],
	): Promise<SessionCatalogEntry[]> {
		const owned = cloneCatalogEntries(entries);
		const fingerprint = catalogFingerprint(owned);
		if (fingerprint !== state.persistedFingerprint || state.persistFailed) {
			serializeSessionCatalog(owned);
			try {
				database.transaction(() => {
					publishEntries(owned);
					database.markImported(SESSION_CATALOG_DATASET_ID, filePath);
				});
			} catch (error) {
				state.persistFailed = true;
				throw error;
			}
			state.persistedFingerprint = fingerprint;
		}
		state.entries = owned;
		state.persistFailed = false;
		return cloneCatalogEntries(owned);
	}

	async function reconcileCurrent(
		state: CatalogState,
		sessions: readonly SessionCatalogSource[],
	): Promise<SessionCatalogEntry[]> {
		const current = (state.entries ?? []).filter((entry) => !state.removedKeys.has(sessionKey(entry.ref)));
		const liveSessions = sessions.filter((summary) => !state.removedKeys.has(sessionKey(toSessionRef(summary))));
		const existingPaths = await existingCatalogFilePaths(current, liveSessions);
		return reconcileSessionCatalog(current, liveSessions, existingPaths);
	}

	function rememberRemovedKey(state: CatalogState, key: string): void {
		state.removedKeys.set(key, true);
	}

	function settleObservedRemovals(
		state: CatalogState,
		sessions: readonly SessionCatalogSource[],
		persisted: readonly SessionCatalogEntry[],
	): void {
		const observedKeys = new Set(sessions.map((summary) => sessionKey(toSessionRef(summary))));
		const persistedKeys = new Set(persisted.map((entry) => sessionKey(entry.ref)));
		for (const key of state.removedKeys.keys()) {
			if (!observedKeys.has(key) && !persistedKeys.has(key)) state.removedKeys.delete(key);
		}
	}

	return {
		retryRead: () => enqueue(async () => {}, true),
		status: () =>
			enqueue(async (state) =>
				state.persistFailed
					? ({ status: "degraded", errorCode: "SESSION_CATALOG_PERSIST_FAILED" } as const)
					: ({ status: "ready" } as const),
			).catch((error: unknown) => ({
				...datasetStoreStatusFromError(error),
			})),
		snapshot: () => enqueue(async (state) => cloneCatalogEntries(state.entries ?? [])),
		retryPersistence: (sessions) =>
			enqueue(async (state, filePath) => {
				if (!state.persistFailed) return;
				const persisted = await persist(state, filePath, await reconcileCurrent(state, sessions));
				settleObservedRemovals(state, sessions, persisted);
			}, true),
		reconcile: (sessions) =>
			enqueue(async (state, filePath) => {
				const persisted = await persist(state, filePath, await reconcileCurrent(state, sessions));
				settleObservedRemovals(state, sessions, persisted);
				return persisted;
			}),
		rebuild: (sessions) => {
			if (disposed) return Promise.reject(shutdownError());
			const result = state.mutations.then(async () => {
				if (!state.readError) {
					try {
						await loadState(state);
					} catch {
						// loadState records the exact read failure used to authorize recovery.
					}
				}
				if (!state.readError) throw new Error("Session catalog recovery is not required");
				const liveSessions = sessions.filter((summary) => !state.removedKeys.has(sessionKey(toSessionRef(summary))));
				const rebuilt = reconcileSessionCatalog([], liveSessions, new Set());
				const persisted = await persist(state, filePath, rebuilt);
				settleObservedRemovals(state, sessions, persisted);
				state.readError = null;
				return persisted;
			});
			state.mutations = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		updateMetadata: (sessions, ref, update) =>
			enqueue(async (state, filePath) => {
				const reconciled = await reconcileCurrent(state, sessions);
				const persisted = await persist(state, filePath, updateSessionCatalogMetadata(reconciled, ref, update));
				settleObservedRemovals(state, sessions, persisted);
				return persisted;
			}),
		remove: (ref) =>
			enqueue(async (state) => {
				const key = sessionKey(ref);
				rememberRemovedKey(state, key);

				// Catalog, metadata, draft recovery and review records disappear in the same durable transaction.
				database.deleteSessionData(ref);
				state.entries = (state.entries ?? []).filter((entry) => sessionKey(entry.ref) !== key);
				state.persistedFingerprint = catalogFingerprint(state.entries);
			}),
		dispose() {
			if (disposal) return disposal;
			disposed = true;
			disposal = state.mutations.finally(() => {
				state.entries = null;
				state.removedKeys.clear();
			});
			return disposal;
		},
	};
}

function compareCatalogSummaries(left: SessionSummary, right: SessionSummary): number {
	const leftArchived = left.archivedAt !== undefined;
	const rightArchived = right.archivedAt !== undefined;
	if (leftArchived !== rightArchived) return leftArchived ? 1 : -1;
	if (left.pinnedAt !== undefined || right.pinnedAt !== undefined) {
		if (left.pinnedAt === undefined) return 1;
		if (right.pinnedAt === undefined) return -1;
		return right.pinnedAt - left.pinnedAt;
	}
	return right.updatedAt - left.updatedAt;
}

function updateSessionCatalogMetadata(
	catalog: readonly SessionCatalogEntry[],
	ref: SessionRef,
	update: { archived?: boolean; pinned?: boolean },
): SessionCatalogEntry[] {
	const now = Date.now();
	const key = sessionKey(ref);
	let found = false;
	const updated = catalog.map((entry) => {
		if (sessionKey(entry.ref) !== key) return entry;
		found = true;
		const next: SessionCatalogEntry = { ...entry };
		if (update.archived !== undefined) {
			if (update.archived) next.archivedAt = now;
			else delete next.archivedAt;
		}
		if (update.pinned !== undefined) {
			if (update.pinned) next.pinnedAt = now;
			else delete next.pinnedAt;
		}
		return next;
	});
	if (!found) throw new Error(`Unknown session in catalog: ${ref.sessionId}`);
	return updated;
}
