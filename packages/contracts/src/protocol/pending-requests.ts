import { toError } from "../ling-error";

export interface PendingRequest<Result, Context, Id extends string | number = string> {
	id: Id;
	context: Context;
	promise: Promise<Result>;
	resolve(value: Result): void;
	reject(error: Error): void;
}

interface PendingRequestOptions<Context, Id> {
	id?: Id;
	context: Context;
	/** Null permits user-driven dialogs and resumable Web requests without a local deadline. */
	deadline: { at: number; error(): Error } | null;
	signal?: AbortSignal;
	abortError?(signal: AbortSignal): Error;
	/** Runs after release, so cancellation/timeout can safely reject other requests on the same host. */
	onExpired?(reason: "deadline" | "abort", error: Error, id: Id): void;
}

/** Transport-neutral correlation and wait ownership. Domains retain envelopes, retries and mutation policy. */
export function createPendingRequests<Context, Id extends string | number = string>(options: {
	capacity: number;
	capacityError(): Error;
	createId(sequence: number): Id;
}) {
	const entries = new Map<Id, PendingRequest<unknown, Context, Id>>();
	let sequence = 1;
	const assertCapacity = (): void => {
		if (entries.size >= options.capacity) throw options.capacityError();
	};
	const allocateId = (): Id => {
		assertCapacity();
		for (let attempt = 0; attempt <= entries.size; attempt += 1) {
			const id = options.createId(sequence);
			sequence = sequence === Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
			if (!entries.has(id)) return id;
		}
		throw options.capacityError();
	};
	const create = <Result>(request: PendingRequestOptions<Context, Id>): PendingRequest<Result, Context, Id> => {
		assertCapacity();
		const id = request.id === undefined ? allocateId() : request.id;
		if (entries.has(id)) throw new Error(`Request id is already pending: ${String(id)}`);
		const { promise, resolve, reject } = Promise.withResolvers<Result>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const signal = request.signal;
		const release = (): boolean => {
			if (entries.get(id) !== entry) return false;
			entries.delete(id);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			return true;
		};
		const expire = (reason: "deadline" | "abort", error: Error): void => {
			if (!release()) return;
			reject(error);
			request.onExpired?.(reason, error, id);
		};
		const onAbort = (): void => {
			if (signal) expire("abort", request.abortError?.(signal) ?? toError(signal.reason));
		};
		const entry: PendingRequest<Result, Context, Id> = {
			id,
			context: request.context,
			promise,
			resolve(value) {
				if (release()) resolve(value);
			},
			reject(error) {
				if (release()) reject(error);
			},
		};
		entries.set(id, entry);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		else if (request.deadline) {
			const deadline = request.deadline;
			if (!Number.isSafeInteger(deadline.at)) entry.reject(new Error("Request deadline must be a safe integer"));
			else if (deadline.at <= Date.now()) expire("deadline", deadline.error());
			else {
				timer = setTimeout(() => expire("deadline", deadline.error()), deadline.at - Date.now());
				// Node timers must not keep a retired worker alive; browser timers are numeric handles.
				const portableTimer = timer as number | { unref?(): void };
				if (typeof portableTimer === "object") portableTimer.unref?.();
			}
		}
		return entry;
	};
	return {
		create,
		allocateId,
		assertCapacity,
		get size() {
			return entries.size;
		},
		get: (id: Id) => entries.get(id),
		keys: () => entries.keys(),
		values: () => entries.values(),
		rejectWhere(predicate: (context: Context) => boolean, error: Error): void {
			for (const entry of [...entries.values()]) if (predicate(entry.context)) entry.reject(error);
		},
	};
}
