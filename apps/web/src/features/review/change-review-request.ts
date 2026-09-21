import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";

interface ChangeReviewRequestToken {
	generation: number;
	key: string;
}

interface ChangeReviewRequestGuard {
	activate(ref: SessionRef | null): void;
	deactivate(ref: SessionRef): void;
	begin(ref: SessionRef): ChangeReviewRequestToken | null;
	isCurrent(token: ChangeReviewRequestToken): boolean;
}

export function createChangeReviewRequestGuard(): ChangeReviewRequestGuard {
	let activeKey: string | null = null;
	let generation = 0;
	return {
		activate(ref) {
			const nextKey = ref ? sessionKey(ref) : null;
			if (nextKey === activeKey) return;
			activeKey = nextKey;
			generation += 1;
		},
		deactivate(ref) {
			if (activeKey !== sessionKey(ref)) return;
			activeKey = null;
			generation += 1;
		},
		begin(ref) {
			const key = sessionKey(ref);
			if (key !== activeKey) return null;
			generation += 1;
			return { generation, key };
		},
		isCurrent(token) {
			return token.key === activeKey && token.generation === generation;
		},
	};
}

interface LatestChangeReviewRequest<T> {
	guard: ChangeReviewRequestGuard;
	ref: SessionRef;
	load(): Promise<T>;
	onStart(): void;
	onSuccess(value: T): void;
	onError(error: unknown): void;
	onSettled(): void;
}

export async function runLatestChangeReviewRequest<T>(request: LatestChangeReviewRequest<T>): Promise<void> {
	const token = request.guard.begin(request.ref);
	if (!token) return;
	request.onStart();
	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, value: await request.load() };
	} catch (error) {
		outcome = { ok: false, error };
	}
	if (!request.guard.isCurrent(token)) return;
	if (outcome.ok) request.onSuccess(outcome.value);
	else request.onError(outcome.error);
	if (request.guard.isCurrent(token)) request.onSettled();
}
