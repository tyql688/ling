import { skinsProcedures } from "@ling/contracts/skin-procedures";
import { SKIN_ID_PATTERN, type UserSkinsSnapshot } from "@ling/contracts/skins";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { subscribe } from "@ling/host/runtime/filesystem-watcher";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import { relative, sep } from "node:path";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import { deleteSkinPackage, ensureSkinsDirectory, listUserSkins, SKINS_DIR } from "./skin-package-store";

const log = createLogger("skins");
/** One save produces an event burst; 150 ms collapses it without making live editing feel delayed. */
const CHANGE_SETTLE_MS = 150;

export function createSkinDomain({ events }: { events: HostEventPublisher }): HostDomain {
	let subscription: Awaited<ReturnType<typeof subscribe>> | null = null;
	let starting: Promise<void> | null = null;
	let settleTimer: NodeJS.Timeout | null = null;
	let disposed = false;
	const revisions = new Map<string, number>();
	let latestSnapshot: UserSkinsSnapshot | null = null;
	let changeRevision = 0;
	let activeRead: Promise<UserSkinsSnapshot> | null = null;
	let watcherError: string | null = null;

	const readSnapshot = (): Promise<UserSkinsSnapshot> => {
		if (activeRead) return activeRead;
		const read = async (): Promise<UserSkinsSnapshot> => {
			for (;;) {
				const revision = changeRevision;
				const snapshot = await listUserSkins(new Map(revisions));
				if (!disposed && revision !== changeRevision) continue;
				const loadedIds = new Set(snapshot.skins.map((skin) => skin.id));
				for (const id of revisions.keys()) {
					if (!loadedIds.has(id)) revisions.delete(id);
				}
				latestSnapshot =
					watcherError === null
						? snapshot
						: {
								...snapshot,
								error: snapshot.error === null ? watcherError : `${snapshot.error}; ${watcherError}`,
							};
				return latestSnapshot;
			}
		};
		activeRead = read().finally(() => {
			activeRead = null;
		});
		return activeRead;
	};

	const publishWatcherFailure = (message: string, error: unknown): void => {
		const normalized = toError(error);
		log.error(`${message}:`, normalized);
		watcherError = `${message}: ${normalized.message}`;
		if (disposed || latestSnapshot === null) return;
		events.broadcast(skinsProcedures.onChanged.channel, {
			...latestSnapshot,
			error: watcherError,
		});
	};

	const broadcast = (): void => {
		settleTimer = null;
		void readSnapshot()
			.then((snapshot) => {
				if (!disposed) events.broadcast(skinsProcedures.onChanged.channel, snapshot);
			})
			.catch((error: unknown) => publishWatcherFailure("Failed to list skin packages after a change", error));
	};

	const ensureWatcher = async (): Promise<void> => {
		if (disposed || subscription) return;
		if (starting) return starting;
		starting = ensureSkinsDirectory()
			.then(() =>
				subscribe(SKINS_DIR, (error, changes) => {
					if (disposed) return;
					if (error) {
						publishWatcherFailure("Skin package watcher failed", error);
						return;
					}
					watcherError = null;
					changeRevision += 1;
					for (const change of changes) {
						const packageId = relative(SKINS_DIR, change.path).split(sep)[0];
						if (packageId && SKIN_ID_PATTERN.test(packageId)) {
							revisions.set(packageId, (revisions.get(packageId) ?? 0) + 1);
						}
					}
					if (settleTimer) clearTimeout(settleTimer);
					settleTimer = setTimeout(broadcast, CHANGE_SETTLE_MS);
				}),
			)
			.then(async (sub) => {
				if (disposed) await sub.unsubscribe();
				else {
					subscription = sub;
					watcherError = null;
				}
			})
			.catch((error: unknown) => publishWatcherFailure("Failed to watch the skin packages directory", error))
			.finally(() => {
				starting = null;
			});
		return starting;
	};
	const handlers: HostHandlers = {
		[skinsProcedures.list.channel]: async (): Promise<UserSkinsSnapshot> => {
			await ensureWatcher();
			return readSnapshot();
		},

		[skinsProcedures.delete.channel]: async (_event, id): Promise<UserSkinsSnapshot> => {
			await deleteSkinPackage(id);
			changeRevision += 1;
			revisions.delete(id);
			return readSnapshot();
		},

		[skinsProcedures.openDir.channel]: async (): Promise<{ dir: string }> => {
			await ensureSkinsDirectory();
			return { dir: SKINS_DIR };
		},
	};
	return {
		handlers,
		dispose: async () => {
			disposed = true;
			if (settleTimer) clearTimeout(settleTimer);
			if (starting) await starting;
			const results = await Promise.allSettled([subscription?.unsubscribe(), activeRead]);
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length > 0) throw new AggregateError(errors, "Skin package shutdown failed");
		},
	};
}
