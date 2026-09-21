import { parseRendererPreferenceMeta } from "@ling/contracts/renderer-preferences";
import type { HostApi } from "@ling/contracts/api/host-procedures";
import {
	USER_STATE_RECOVERY_MAX_CHARS,
	applyUserStateMutation,
	emptyUserState,
	userStateRecoverySchema,
	type UserStateChange,
	type UserStateSnapshot,
} from "@ling/contracts/user-state";
import { errorMessage } from "@ling/contracts/ling-error";
import type { createStore } from "jotai/vanilla";
import {
	LEGACY_REVIEWED_PREFIX,
	LEGACY_USER_STATE_KEYS,
	parseLegacyUserState,
} from "@ling/contracts/legacy-user-state";
import {
	mutateUserStateAtom,
	pendingUserMutationsAtom,
	retryUserStateAtom,
	userStateAtom,
	userStateStatusAtom,
} from "./state";

type Store = ReturnType<typeof createStore>;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const JOURNAL_KEY = "ling:user-state-recovery";
// This journal holds unacknowledged operations only. Its limit remains within typical browser storage quotas.

/** Batches frequent read-marker updates without placing timers or IO in atom writers. */
const SAVE_DELAY_MS = 500;

export function createUserStatePersistence(store: Store, storage: StoragePort, api: HostApi["userState"]) {
	let disposed = false;
	let initialized = false;
	let restoring = true;
	let journalDamaged = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let revision = -1;
	let authoritative = emptyUserState();
	let refreshPromise: Promise<void> | null = null;
	let refreshAgain = false;
	let writing: Promise<void> | null = null;
	let synchronizing: Promise<void> | null = null;
	let sourceIssues: UserStateSnapshot["issues"] = [];
	let remoteIssues: UserStateSnapshot["issues"] = [];
	const report = (error: unknown) => {
		if (!disposed) store.set(userStateStatusAtom, (previous) => ({ ...previous, error: errorMessage(error) }));
	};
	function publish() {
		if (disposed) return;
		const state = store
			.get(pendingUserMutationsAtom)
			.reduce((state, entry) => applyUserStateMutation(state, entry.mutation), authoritative);
		store.set(userStateAtom, state);
		store.set(userStateStatusAtom, (previous) => ({ ...previous, issues: [...sourceIssues, ...remoteIssues] }));
	}
	function journal() {
		if (restoring || journalDamaged) return;
		try {
			const pending = store.get(pendingUserMutationsAtom);
			if (pending.length === 0) storage.removeItem(JOURNAL_KEY);
			else {
				const raw = JSON.stringify({ version: 1, mutations: pending.map((entry) => entry.mutation) });
				if (raw.length > USER_STATE_RECOVERY_MAX_CHARS)
					throw new Error("Pending user changes exceed the local recovery budget");
				storage.setItem(JOURNAL_KEY, raw);
			}
		} catch (error) {
			report(error);
		}
	}
	function restoreJournal() {
		restoring = true;
		try {
			const raw = storage.getItem(JOURNAL_KEY);
			if (raw !== null) {
				if (raw.length > USER_STATE_RECOVERY_MAX_CHARS)
					throw new Error("User state recovery journal exceeds its storage budget");
				const journal = userStateRecoverySchema.parse(JSON.parse(raw));
				// In-memory edits made after a failed restore remain newer than the recovered journal.
				const newer = store.get(pendingUserMutationsAtom).map((entry) => entry.mutation);
				store.set(pendingUserMutationsAtom, []);
				store.set(mutateUserStateAtom, [...journal.mutations, ...newer]);
			}
			journalDamaged = false;
		} catch (error) {
			journalDamaged = true;
			report(error);
		} finally {
			restoring = false;
		}
	}
	async function importLegacy() {
		try {
			const rawMeta = storage.getItem("ling:preferences-meta");
			if (rawMeta !== null) {
				const meta = parseRendererPreferenceMeta(rawMeta);
				if ("futureVersion" in meta)
					throw new Error(`User preferences were written by future schema version ${meta.futureVersion}`);
			}
		} catch (error) {
			sourceIssues = [{ key: "ling:preferences-meta", message: errorMessage(error) }];
			return;
		}
		const keys = new Set(LEGACY_USER_STATE_KEYS);
		for (let index = 0; index < storage.length; index++) {
			const key = storage.key(index);
			if (key?.startsWith(LEGACY_REVIEWED_PREFIX) && key !== `${LEGACY_REVIEWED_PREFIX}index`) keys.add(key);
		}
		const issues: UserStateSnapshot["issues"] = [];
		for (const key of keys) {
			if (disposed) return;
			try {
				const raw = storage.getItem(key);
				if (raw === null) continue;
				const parsed = parseLegacyUserState(key, raw);
				const digest = Array.from(
					new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
					(value) => value.toString(16).padStart(2, "0"),
				).join("");
				if (disposed) return;
				await api.importLegacy({ source: key, digest, mutations: parsed.mutations });
				if (disposed) return;
				if (parsed.issues.length > 0) issues.push({ key, message: parsed.issues.join("\n") });
				else if (storage.getItem(key) === raw) storage.removeItem(key);
			} catch (error) {
				issues.push({ key, message: errorMessage(error) });
			}
		}
		sourceIssues = issues;
	}
	function acceptSnapshot(snapshot: UserStateSnapshot) {
		if (disposed || snapshot.revision < revision) return;
		// Explicit partial results keep healthy entities usable. Failed sources remain visible and are never written back as defaults.
		authoritative = snapshot.state;
		revision = snapshot.revision;
		remoteIssues = snapshot.issues;
		publish();
	}
	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve();
		if (refreshPromise) {
			refreshAgain = true;
			return refreshPromise;
		}
		refreshPromise = (async () => {
			do {
				refreshAgain = false;
				acceptSnapshot(await api.get());
			} while (refreshAgain && !disposed);
		})().finally(() => {
			refreshPromise = null;
		});
		return refreshPromise;
	}
	async function acceptChange(change: UserStateChange) {
		if (disposed || change.revision <= revision) return;
		if (revision < 0 || change.mutations === null || change.revision !== revision + 1) {
			await refresh();
			return;
		}
		authoritative = change.mutations.reduce(applyUserStateMutation, authoritative);
		revision = change.revision;
		publish();
	}
	function flush(): Promise<void> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (disposed || !initialized) return Promise.resolve();
		if (writing) return writing;
		writing = (async () => {
			const blockedTypes = new Set<string>();
			while (!disposed) {
				const pending = store.get(pendingUserMutationsAtom).filter((entry) => !blockedTypes.has(entry.mutation.type));
				const kind = pending[0]?.mutation.type;
				// A damaged metadata dataset must not hold back unrelated preferences or read markers.
				const batch = pending.filter((entry) => entry.mutation.type === kind).slice(0, 256);
				if (batch.length === 0) break;
				try {
					const change = await api.update(batch.map((entry) => entry.mutation));
					await acceptChange(change);
					if (disposed) return;
					const acknowledged = new Set(batch.map((entry) => entry.id));
					store.set(pendingUserMutationsAtom, (pending) => pending.filter((entry) => !acknowledged.has(entry.id)));
					publish();
					if (!journalDamaged && blockedTypes.size === 0)
						store.set(userStateStatusAtom, (previous) => ({ ...previous, error: null }));
					journal();
				} catch (error) {
					report(error);
					if (kind !== undefined) blockedTypes.add(kind);
				}
			}
		})().finally(() => {
			writing = null;
		});
		return writing;
	}
	const releasePending = store.sub(pendingUserMutationsAtom, () => {
		if (disposed || restoring) return;
		journal();
		if (timer === null && initialized)
			timer = setTimeout(() => {
				timer = null;
				void flush();
			}, SAVE_DELAY_MS);
	});
	const releaseChanged = api.onChanged((change) => {
		if (initialized) void acceptChange(change).catch(report);
	});
	function synchronize(): Promise<void> {
		if (synchronizing) return synchronizing;
		synchronizing = (async () => {
			try {
				if (!initialized || journalDamaged) restoreJournal();
				await importLegacy();
				await refresh();
				if (disposed) return;
				initialized = true;
				if (!journalDamaged) store.set(userStateStatusAtom, (previous) => ({ ...previous, error: null }));
				await flush();
			} catch (error) {
				report(error);
			} finally {
				if (!disposed) {
					initialized = true;
					store.set(userStateStatusAtom, (previous) => ({ ...previous, ready: true }));
					publish();
					journal();
				}
			}
		})().finally(() => {
			synchronizing = null;
		});
		return synchronizing;
	}
	store.set(retryUserStateAtom, () => synchronize);
	const ready = synchronize();
	return {
		ready,
		flush,
		dispose() {
			if (disposed) return;
			journal();
			disposed = true;
			if (timer) clearTimeout(timer);
			releasePending();
			releaseChanged();
			store.set(retryUserStateAtom, null);
		},
	};
}
