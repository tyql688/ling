import {
	USER_STATE_RECOVERY_MAX_CHARS,
	applyUserStateMutation,
	emptyUserState,
	OPEN_SESSION_TABS_MAX_ITEMS,
	type SharedPreference,
	type UserState,
	type UserStateMutation,
} from "@ling/contracts/user-state";
import { sessionKey } from "@ling/contracts/session-ref";
import { atom } from "jotai";

export const userStateAtom = atom<UserState>(emptyUserState());
interface PendingUserMutation {
	id: number;
	mutation: UserStateMutation;
}
export const pendingUserMutationsAtom = atom<PendingUserMutation[]>([]);
const sequenceAtom = atom(0);
export const userStateStatusAtom = atom<{
	ready: boolean;
	error: string | null;
	issues: { key: string; message: string }[];
}>({ ready: false, error: null, issues: [] });
export const retryUserStateAtom = atom<(() => Promise<void>) | null>(null);

function mutationKey(mutation: UserStateMutation): string {
	switch (mutation.type) {
		case "projectPin":
		case "projectName":
			return `${mutation.type}:${mutation.cwd}`;
		case "sessionSeen":
			return `${mutation.type}:${sessionKey(mutation.ref)}`;
		case "reviewMark":
			return `${mutation.type}:${sessionKey(mutation.ref)}\0${mutation.path}`;
		case "preference":
			return `${mutation.type}:${mutation.preference.key}`;
		case "tabs":
			return "tabs";
		case "skinScene":
			return `${mutation.type}:${mutation.key}`;
		case "lastProject":
		case "sidebarScope":
			return mutation.type;
	}
}
/** Coalescing is by operation identity, so another client's unrelated changes are never replaced by an old whole-map save. */
function mergePendingMutation(pending: PendingUserMutation[], entry: PendingUserMutation): PendingUserMutation[] {
	const key = mutationKey(entry.mutation);
	const previous = pending.find((item) => mutationKey(item.mutation) === key);
	if (previous?.mutation.type === "sessionSeen" && entry.mutation.type === "sessionSeen") {
		entry = {
			...entry,
			mutation: { ...entry.mutation, seenAt: Math.max(previous.mutation.seenAt, entry.mutation.seenAt) },
		};
	}
	if (previous?.mutation.type === "tabs" && entry.mutation.type === "tabs") {
		const added = new Map(previous.mutation.add.map((ref) => [sessionKey(ref), ref]));
		const removed = new Map(previous.mutation.remove.map((ref) => [sessionKey(ref), ref]));
		for (const ref of entry.mutation.remove) {
			added.delete(sessionKey(ref));
			removed.set(sessionKey(ref), ref);
		}
		for (const ref of entry.mutation.add) {
			removed.delete(sessionKey(ref));
			added.set(sessionKey(ref), ref);
		}
		// Keep tab operations separate when repeated offline closes exceed a single request's strip-sized budget.
		if (added.size > OPEN_SESSION_TABS_MAX_ITEMS || removed.size > OPEN_SESSION_TABS_MAX_ITEMS)
			return [...pending, entry];
		const order = entry.mutation.order ?? previous.mutation.order;
		entry = {
			...entry,
			mutation: {
				type: "tabs",
				add: [...added.values()],
				remove: [...removed.values()],
				...(order === undefined ? {} : { order }),
			},
		};
	}
	return [...pending.filter((item) => item !== previous), entry];
}
export const mutateUserStateAtom = atom(null, (get, set, mutations: UserStateMutation[]) => {
	let state = get(userStateAtom),
		pending = get(pendingUserMutationsAtom),
		sequence = get(sequenceAtom);
	for (const mutation of mutations) {
		pending = mergePendingMutation(pending, { id: ++sequence, mutation });
		state = applyUserStateMutation(state, mutation);
	}
	if (
		pending.length > 10_000 ||
		JSON.stringify({ version: 1, mutations: pending.map((entry) => entry.mutation) }).length >
			USER_STATE_RECOVERY_MAX_CHARS
	) {
		set(userStateStatusAtom, (previous) => ({ ...previous, error: "Pending user changes exceed the recovery budget" }));
		return;
	}
	set(sequenceAtom, sequence);
	set(userStateAtom, state);
	set(pendingUserMutationsAtom, pending);
});

/** Feature atoms select one owned value; only the renderer persistence owner performs IO. */
export function userStateFieldAtom<Key extends keyof UserState>(
	key: Key,
	changes: (before: UserState[Key], after: UserState[Key]) => UserStateMutation[],
) {
	return atom(
		(get) => get(userStateAtom)[key],
		(get, set, update: UserState[Key] | ((current: UserState[Key]) => UserState[Key])) => {
			const current = get(userStateAtom)[key];
			const next = typeof update === "function" ? update(current) : update;
			if (current !== next) set(mutateUserStateAtom, changes(current, next));
		},
	);
}
export function sharedPreferenceAtom<Key extends SharedPreference["key"]>(
	key: Key,
	fallback: Extract<SharedPreference, { key: Key }>["value"],
) {
	type Value = Extract<SharedPreference, { key: Key }>["value"];
	return atom(
		// A missing shared preference means the user has not configured this option yet.
		(get) => (get(userStateAtom).preferences[key] ?? fallback) as Value,
		(get, set, update: Value | ((current: Value) => Value)) => {
			const current = (get(userStateAtom).preferences[key] ?? fallback) as Value;
			const value = typeof update === "function" ? update(current) : update;
			set(mutateUserStateAtom, [{ type: "preference", preference: { key, value } as SharedPreference }]);
		},
	);
}
