import { createPendingRequests, type PendingRequest } from "@ling/contracts/protocol/pending-requests";
import { assertJsonFrameSize } from "@ling/core/json-frame";
import { createLingError, isLingError, toError } from "@ling/core/ling-error";
import { lingErrorDtoSchema } from "@ling/contracts/ling-error";
import { createBirpc } from "birpc";
import { z } from "zod";
import type { Serializable } from "node:child_process";

/** Node's send return value reports backpressure; its callback owns delivery failure. */
export function postWorkerMessage(
	channel: { send?: (message: Serializable, callback: (error: Error | null) => void) => unknown },
	value: unknown,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!channel.send) {
			reject(new Error("Worker IPC channel is unavailable"));
			return;
		}
		channel.send(value as Serializable, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

/** Short birpc correlation ids and one DTO argument bound dispatch overhead independently of payload limits. */
const rpcIdSchema = z.string().min(1).max(128);
const rpcFrameSchema = z.discriminatedUnion("t", [
	z.strictObject({
		t: z.literal("q"),
		i: rpcIdSchema.optional(),
		m: z.enum(["request", "event"]),
		a: z.tuple([z.unknown()]),
	}),
	z.strictObject({ t: z.literal("s"), i: rpcIdSchema, r: z.unknown().optional(), e: z.unknown().optional() }),
]);
const rpcErrorSchema = z.strictObject({ message: z.string().max(2_000), lingError: lingErrorDtoSchema.optional() });
const requestEnvelopeSchema = z.strictObject({ id: rpcIdSchema, payload: z.unknown() });

interface WorkerRpcCall<Context> {
	context: Context;
	deadline: { at: number; error(): Error } | null;
	signal?: AbortSignal;
	abortError?(signal: AbortSignal): Error;
	onExpired?(reason: "deadline" | "abort", error: Error, id: string): void;
	onAdmitted?(request: PendingRequest<unknown, Context>): void;
}

interface WorkerRpcOptions<Request, Response> {
	capacity: number;
	capacityError(): Error;
	maxFrameBytes: number;
	post(value: unknown): void | Promise<void>;
	onMessage(listener: (value: unknown) => void): () => void;
	receiveRequest?(payload: unknown, id: string): Response | Promise<Response>;
	receiveEvent?(value: unknown): void;
	parseResponse(value: unknown, request: Request): Response;
	onError(error: Error): void;
}

/** birpc owns dispatch/correlation; the shared request owner supplies bounded waits without cancellation frames. */
export function createWorkerRpc<Request, Response, Event, Context = undefined>(
	options: WorkerRpcOptions<Request, Response>,
) {
	const pending = createPendingRequests<Context>({
		capacity: options.capacity,
		capacityError: options.capacityError,
		// birpc supplies the actual id in onRequest; allocation is used only by the common owner API.
		createId: (sequence) => `worker-${sequence}`,
	});
	const invocations = new WeakMap<object, WorkerRpcCall<Context>>();
	let unsubscribe: (() => void) | null = null;
	let closed = false;
	function close(error: Error): void {
		if (closed) return;
		closed = true;
		pending.rejectWhere(() => true, error);
		rpc.$close(error);
	}
	const rpc = createBirpc<{ request(value: object): Promise<unknown>; event(value: Event): void }>(
		{
			async request(value: unknown) {
				if (!options.receiveRequest) throw new Error("This worker endpoint does not accept requests");
				const envelope = requestEnvelopeSchema.parse(value);
				return await options.receiveRequest(envelope.payload, envelope.id);
			},
			event(value: unknown) {
				try {
					if (!options.receiveEvent) throw new Error("This worker endpoint does not accept events");
					options.receiveEvent(value);
				} catch (error) {
					options.onError(toError(error));
				}
			},
		},
		{
			// All deadlines belong to pending-requests. birpc must not apply an additional one-minute timeout.
			timeout: -1,
			eventNames: ["event"],
			async post(value: unknown) {
				try {
					await options.post(value);
				} catch (error) {
					const failure = toError(error);
					options.onError(failure);
					close(failure);
					// A request must adopt birpc's rejected response promise after send completes.
					// Throwing here skips that adoption and strands a rejection during $close.
					const frame = rpcFrameSchema.parse(value);
					if (frame.t === "q" && frame.i) return;
					throw failure;
				}
			},
			serialize(value: unknown) {
				const frame = rpcFrameSchema.parse(value);
				if (frame.t !== "s" || frame.e === undefined) return frame;
				const error = toError(frame.e);
				return {
					...frame,
					e: { message: error.message.slice(0, 2_000), ...(isLingError(error) ? { lingError: error.lingError } : {}) },
				};
			},
			deserialize(value: unknown) {
				const frame = rpcFrameSchema.parse(value);
				if (frame.t !== "s" || frame.e === undefined) return frame;
				const error = rpcErrorSchema.parse(frame.e);
				return { ...frame, e: error.lingError ? createLingError(error.lingError) : new Error(error.message) };
			},
			on(listener) {
				unsubscribe = options.onMessage((value) => {
					if (closed) return;
					try {
						assertJsonFrameSize(value, options.maxFrameBytes, "Worker RPC frame");
						const frame = rpcFrameSchema.parse(value);
						// Observe asynchronous dispatch failures too; a void message listener would lose them.
						void Promise.resolve(listener(frame)).catch((error: unknown) => options.onError(toError(error)));
					} catch (error) {
						options.onError(toError(error));
					}
				});
			},
			off() {
				unsubscribe?.();
				unsubscribe = null;
			},
			async onRequest(frame, next, resolve) {
				const argument: unknown = frame.a[0];
				if (typeof argument !== "object" || argument === null || !frame.i) throw new Error("Invalid local worker call");
				const invocation = invocations.get(argument);
				if (!invocation || !("payload" in argument)) throw new Error("Unowned worker call");
				invocations.delete(argument);
				const request = pending.create<unknown>({ id: frame.i, ...invocation });
				if (pending.get(request.id) === request) {
					try {
						invocation.onAdmitted?.(request);
						void next({ ...frame, a: [{ id: request.id, payload: argument.payload }] }).then(request.resolve, (error) =>
							request.reject(toError(error)),
						);
					} catch (error) {
						request.reject(toError(error));
					}
				}
				resolve(await request.promise);
			},
		},
	);
	return {
		async call(request: Request, invocation: WorkerRpcCall<Context>): Promise<Response> {
			if (closed) throw new Error("Worker RPC is closed");
			pending.assertCapacity();
			const argument = { payload: request };
			invocations.set(argument, invocation);
			try {
				return options.parseResponse(await rpc.request(argument), request);
			} finally {
				invocations.delete(argument);
			}
		},
		async emit(event: Event): Promise<void> {
			await rpc.event(event);
		},
		get size() {
			return pending.size;
		},
		values: () => pending.values(),
		get: (id: string) => pending.get(id),
		close,
	};
}
