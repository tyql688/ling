import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";

interface ReplacedRuntimeRefTombstone {
	previousRef: SessionRef;
	replacementRef: SessionRef;
	expiresAt: number;
}

/** Retain replaced references long enough for in-flight companion and snapshot requests to settle. Expiry ends reference rewriting and bounds tombstone retention. */
const REPLACED_REF_RETENTION_MS = 5 * 60 * 1000;
export function createReplacedRuntimeRefIndex() {
	const tombstones = new Map<string, ReplacedRuntimeRefTombstone>();

	const prune = (now = Date.now()): void => {
		for (const [key, tombstone] of tombstones) {
			if (tombstone.expiresAt <= now) tombstones.delete(key);
		}
	};

	return {
		remember(previousRef: SessionRef, replacementRef: SessionRef): void {
			const now = Date.now();
			prune(now);
			const key = sessionKey(previousRef);
			tombstones.delete(key);
			tombstones.set(key, {
				previousRef: { ...previousRef },
				replacementRef: { ...replacementRef },
				expiresAt: now + REPLACED_REF_RETENTION_MS,
			});
			prune(now);
		},
		find(ref: SessionRef): SessionRef | undefined {
			prune();
			const replacementRef = tombstones.get(sessionKey(ref))?.replacementRef;
			return replacementRef === undefined ? undefined : { ...replacementRef };
		},
		forgetPrevious(ref: SessionRef): void {
			tombstones.delete(sessionKey(ref));
		},
		clearSession(ref: SessionRef): void {
			const key = sessionKey(ref);
			for (const [previousKey, tombstone] of tombstones) {
				if (previousKey === key || sessionKey(tombstone.replacementRef) === key) tombstones.delete(previousKey);
			}
		},
		clearProject(cwd: string): void {
			for (const [key, tombstone] of tombstones) {
				if (tombstone.previousRef.cwd === cwd || tombstone.replacementRef.cwd === cwd) tombstones.delete(key);
			}
		},
	};
}
