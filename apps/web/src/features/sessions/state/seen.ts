import { parseSessionKey } from "@ling/contracts/session-ref";
import { userStateFieldAtom } from "@renderer/lib/user-state/state";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";

export const sessionSeenAtAtom = userStateFieldAtom("sessionSeenAt", (before, after) =>
	Object.entries(after).flatMap(([key, seenAt]) => {
		const ref = parseSessionKey(key);
		return ref && before[key] !== seenAt ? [{ type: "sessionSeen" as const, ref, seenAt }] : [];
	}),
);
/** Rows subscribe only to their own read marker. */
export const sessionSeenAtFamily = atomFamily((key: string) => atom((get) => get(sessionSeenAtAtom)[key]));
