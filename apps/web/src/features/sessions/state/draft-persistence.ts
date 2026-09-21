import type { HostApi } from "@ling/contracts/api/host-procedures";
import {
	DRAFT_MAX_CHARS,
	DRAFT_STORE_MAX_CHARS,
	DRAFT_STORE_MAX_ITEMS,
	writeDraftSchema,
	type DraftConflict,
	type StoredDraft,
	type WriteDraft,
} from "@ling/contracts/draft";
import { errorMessage } from "@ling/contracts/ling-error";
import { atom } from "jotai/vanilla";
import type { Store } from "jotai/vanilla/store";
import { rebaseContextPositions } from "./draft-context";
import {
	draftsAtom,
	EMPTY_DRAFT,
	persistSessionDraft,
	restoreSessionDraft,
	validDraftKey,
	type SessionDraft,
} from "./drafts";

const LEGACY_KEY = "ling:composer-drafts";
/** Only unacknowledged writes remain here; authoritative drafts belong to Host, independently of its port. */
const RECOVERY_KEY = "ling:draft-recovery";
/** Preserve the previous typing cadence while checkpointing continuous input every five seconds. */
const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;
type DraftApi = HostApi["draft"];
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface PendingDraft {
	request: WriteDraft;
	blocked: boolean;
}
export const draftPersistenceStatusAtom = atom<{
	ready: boolean;
	restoreFailed: boolean;
	saveError: string | null;
	omitted: number;
	conflicts: DraftConflict[];
	localConflicts: string[];
}>({ ready: false, restoreFailed: false, saveError: null, omitted: 0, conflicts: [], localConflicts: [] });
export const draftPersistenceActionsAtom = atom<{
	retry(): Promise<void>;
	resolveLocal(key: string, choice: "local" | "remote"): Promise<void>;
	resolveRecovery(id: string, choice: "recover" | "discard"): Promise<void>;
} | null>(null);

/** Owns subscriptions, revision fences, typing checkpoints and temporary local recovery for one renderer. */
export function createDraftPersistence(store: Store, storage: DraftStorage, api: DraftApi) {
	const pending = new Map<string, PendingDraft>();
	const authoritative = new Map<string, StoredDraft>();
	let initialized = false;
	let disposed = false;
	let applying = false;
	let restoreFailed = false;
	let hostRestoreFailed = false;
	let legacySource: string | null = null;
	let journalBlocked = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
	let flushing: Promise<void> | null = null;
	let refreshing: Promise<void> | null = null;
	let refreshAgain = false;
	let previous = store.get(draftsAtom);
	const report = (error: unknown) =>
		store.set(draftPersistenceStatusAtom, (status) => ({ ...status, saveError: errorMessage(error) }));
	const status = () =>
		store.set(draftPersistenceStatusAtom, (current) => ({
			...current,
			ready: initialized,
			restoreFailed: restoreFailed || hostRestoreFailed,
			localConflicts: [...pending].filter(([, value]) => value.blocked).map(([key]) => key),
		}));
	function applyDraft(key: string, draft: StoredDraft["draft"]) {
		applying = true;
		try {
			store.set(draftsAtom, (drafts) => {
				const old = drafts[key] ?? EMPTY_DRAFT;
				const next: SessionDraft = { ...(draft ?? EMPTY_DRAFT), attachments: old.attachments };
				const images = rebaseContextPositions(old.text, next.text, old.contextPositions ?? []).filter(
					(position) => position.kind === "image",
				);
				next.contextPositions = [...(next.contextPositions ?? []), ...images];
				return { ...drafts, [key]: next };
			});
		} finally {
			applying = false;
			previous = store.get(draftsAtom);
		}
	}
	function accept(current: StoredDraft) {
		const known = authoritative.get(current.key);
		const latest = known && known.revision > current.revision ? known : current;
		authoritative.set(latest.key, latest);
		// Keep revision fences for recent clears; pending operations retain their own fences until acknowledgement.
		for (const [key, stored] of authoritative) {
			if (authoritative.size <= DRAFT_STORE_MAX_ITEMS + pending.size) break;
			if (stored.draft === null && !pending.has(key)) authoritative.delete(key);
		}
		if (
			!pending.has(latest.key) &&
			JSON.stringify(persistSessionDraft(store.get(draftsAtom)[latest.key] ?? EMPTY_DRAFT)) !==
				JSON.stringify(latest.draft)
		)
			applyDraft(latest.key, latest.draft);
	}
	function clearTimers() {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		if (deadlineTimer !== null) clearTimeout(deadlineTimer);
		debounceTimer = null;
		deadlineTimer = null;
	}
	function checkpoint() {
		if (journalBlocked)
			throw new Error("The previous draft recovery journal needs attention before it can be replaced.");
		const raw = JSON.stringify([...pending.values()].map((value) => value.request));
		if (raw.length > DRAFT_STORE_MAX_CHARS || pending.size > DRAFT_STORE_MAX_ITEMS)
			throw new Error(
				"Unsent drafts exceed the local recovery budget. Keep this window open and save or remove a draft.",
			);
		if (pending.size === 0) storage.removeItem(RECOVERY_KEY);
		else storage.setItem(RECOVERY_KEY, raw);
		// Delete only the exact legacy source that was acknowledged; edits in another tab are not ours to remove.
		if (!restoreFailed && pending.size === 0 && legacySource !== null && storage.getItem(LEGACY_KEY) === legacySource) {
			storage.removeItem(LEGACY_KEY);
			legacySource = null;
		}
	}
	function restoreLocal() {
		const restored: Record<string, SessionDraft> = {};
		try {
			legacySource = storage.getItem(LEGACY_KEY);
			if (legacySource !== null) {
				if (legacySource.length > DRAFT_MAX_CHARS) throw new Error("Stored drafts exceed the legacy size limit");
				const parsed: unknown = JSON.parse(legacySource);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid stored drafts");
				const entries = Object.entries(parsed);
				restoreFailed = entries.length > DRAFT_STORE_MAX_ITEMS;
				for (const [key, value] of entries.slice(0, DRAFT_STORE_MAX_ITEMS)) {
					if (!validDraftKey(key)) {
						restoreFailed = true;
						continue;
					}
					const result = restoreSessionDraft(value);
					restoreFailed ||= result.partial;
					if (!result.draft) continue;
					Object.defineProperty(restored, key, { value: result.draft, enumerable: true, configurable: true });
					pending.set(key, {
						request: { key, baseRevision: 0, draft: persistSessionDraft(result.draft) },
						blocked: false,
					});
				}
			}
		} catch (error) {
			restoreFailed = true;
			report(error);
		}
		try {
			const raw = storage.getItem(RECOVERY_KEY);
			if (raw !== null) {
				if (raw.length > DRAFT_STORE_MAX_CHARS) throw new Error("Draft recovery journal exceeds its size limit");
				const parsed: unknown = JSON.parse(raw);
				if (!Array.isArray(parsed) || parsed.length > DRAFT_STORE_MAX_ITEMS)
					throw new Error("Invalid draft recovery journal");
				for (const value of parsed) {
					const request = writeDraftSchema.parse(value);
					pending.set(request.key, { request, blocked: false });
					Object.defineProperty(restored, request.key, {
						value: { ...(request.draft ?? EMPTY_DRAFT), attachments: [] },
						enumerable: true,
						configurable: true,
					});
				}
			}
		} catch (error) {
			restoreFailed = true;
			journalBlocked = true;
			report(error);
		}
		applying = true;
		try {
			store.set(draftsAtom, { ...restored, ...previous });
		} finally {
			applying = false;
			previous = store.get(draftsAtom);
		}
		status();
	}
	function refresh(): Promise<void> {
		if (refreshing) {
			refreshAgain = true;
			return refreshing;
		}
		const operation = (async () => {
			do {
				refreshAgain = false;
				const snapshot = await api.list();
				if (disposed) return;
				hostRestoreFailed = snapshot.issues.length > 0;
				for (const current of snapshot.drafts) accept(current);
				const present = new Set([
					...snapshot.drafts.map((value) => value.key),
					...snapshot.issues.map((value) => value.key),
				]);
				for (const [key, known] of authoritative) {
					if (present.has(key) || known.draft === null) continue;
					const current = await api.get(key);
					if (disposed) return;
					accept(current);
				}
				store.set(draftPersistenceStatusAtom, (current) => ({ ...current, conflicts: snapshot.conflicts }));
				initialized = true;
				status();
			} while (refreshAgain);
		})();
		refreshing = operation.finally(() => {
			refreshing = null;
		});
		return refreshing;
	}
	async function flushPending() {
		if (!initialized) await refresh();
		const errors: unknown[] = [];
		for (const [key, value] of [...pending].sort(
			([, a], [, b]) => Number(a.request.draft !== null) - Number(b.request.draft !== null),
		)) {
			if (disposed || value.blocked) continue;
			try {
				if (!authoritative.has(key)) {
					const current = await api.get(key);
					if (disposed) return;
					accept(current);
					// A tombstone is empty authoritative state; a new edit can safely build on its revision.
					if (value.request.baseRevision === 0 && current.draft === null)
						value.request = { ...value.request, baseRevision: current.revision };
				}
				const result = await api.write(value.request);
				if (disposed) return;
				accept(result.current);
				const latest = pending.get(key);
				if (result.status === "conflict") {
					if (latest) latest.blocked = true;
					await refresh();
				} else if (latest === value) {
					pending.delete(key);
					accept(result.current);
				} else if (latest) {
					latest.request = { ...latest.request, baseRevision: result.current.revision };
				}
				checkpoint();
				status();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, errors.map((error) => errorMessage(error)).join("; "));
		store.set(draftPersistenceStatusAtom, (current) => ({ ...current, saveError: null }));
	}
	function flush(): Promise<void> {
		clearTimers();
		try {
			checkpoint();
		} catch (error) {
			report(error);
		}
		if (disposed) return Promise.resolve();
		if (flushing) return flushing;
		let saved = false;
		const operation = flushPending()
			.then(() => {
				saved = true;
			})
			.catch(report)
			.finally(() => {
				flushing = null;
				if (saved && !disposed && [...pending.values()].some((value) => !value.blocked)) schedule();
			});
		flushing = operation;
		return operation;
	}
	function schedule() {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void flush();
		}, DEBOUNCE_MS);
		deadlineTimer ??= setTimeout(() => {
			void flush();
		}, MAX_WAIT_MS);
	}
	restoreLocal();
	const unsubscribeStore = store.sub(draftsAtom, () => {
		const next = store.get(draftsAtom);
		if (!applying)
			for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
				if (previous[key] === next[key]) continue;
				const draft = persistSessionDraft(next[key] ?? EMPTY_DRAFT);
				if (JSON.stringify(draft) === JSON.stringify(persistSessionDraft(previous[key] ?? EMPTY_DRAFT))) continue;
				const old = pending.get(key);
				pending.set(key, {
					request: { key, draft, baseRevision: old?.request.baseRevision ?? authoritative.get(key)?.revision ?? 0 },
					blocked: old?.blocked ?? false,
				});
				schedule();
			}
		previous = next;
	});
	const unsubscribeHost = api.onChanged((event) => {
		if (disposed) return;
		if (event.type === "updated") accept(event.current);
		else void refresh().catch(report);
	});
	async function resolveLocal(key: string, choice: "local" | "remote") {
		const value = pending.get(key);
		if (!value) return;
		try {
			const current = await api.get(key);
			const request =
				choice === "local"
					? { ...value.request, baseRevision: current.revision, preservePrevious: true as const }
					: value.request;
			// Accepting the remote version first publishes any newer local edit as a recovery version.
			const result = await api.write(request);
			if (disposed) return;
			accept(result.current);
			if (pending.get(key) === value && (choice === "remote" || result.status === "saved")) {
				pending.delete(key);
				accept(result.current);
			} else {
				const latest = pending.get(key);
				if (latest && result.status === "saved") {
					latest.request = { ...latest.request, baseRevision: result.current.revision };
					latest.blocked = false;
					schedule();
				} else if (latest) latest.blocked = true;
			}
			checkpoint();
			await refresh();
			status();
		} catch (error) {
			report(error);
		}
	}
	async function resolveRecovery(id: string, choice: "recover" | "discard") {
		const conflict = store.get(draftPersistenceStatusAtom).conflicts.find((value) => value.id === id);
		if (!conflict) return;
		try {
			if (choice === "recover" && pending.has(conflict.key))
				throw new Error("Save or resolve the current local draft before restoring a recovery version.");
			const current = await api.get(conflict.key);
			const result = await api.resolveConflict({ id, choice, baseRevision: current.revision });
			if (disposed) return;
			if (result !== null) accept(result.current);
			await refresh();
		} catch (error) {
			report(error);
		}
	}
	const actions = {
		async retry() {
			try {
				await refresh();
				await flush();
			} catch (error) {
				report(error);
			}
		},
		resolveLocal,
		resolveRecovery,
	};
	store.set(draftPersistenceActionsAtom, actions);
	const ready = flush();
	return {
		ready,
		flush,
		dispose() {
			if (disposed) return;
			unsubscribeStore();
			unsubscribeHost();
			clearTimers();
			try {
				checkpoint();
			} catch (error) {
				report(error);
			}
			disposed = true;
			if (store.get(draftPersistenceActionsAtom) === actions) store.set(draftPersistenceActionsAtom, null);
		},
	};
}
