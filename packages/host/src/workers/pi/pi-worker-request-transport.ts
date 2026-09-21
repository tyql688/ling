import { createPendingRequests, type PendingRequest } from "@ling/contracts/protocol/pending-requests";
import { requestCapacityExceeded, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { PiCall, PiMethodResult, PiRequestParams } from "@ling/core/pi-protocol/methods";
import { parsePiWorkerOperationResult, piMethods, type PiWorkerMethod } from "@ling/core/pi-protocol/methods";
import type { PiWorkerRequest } from "@ling/core/pi-protocol/protocol";
import { parsePiWorkerResponse, piWorkerError } from "@ling/core/pi-protocol/protocol-validation";
import type { PiWorkerRequestPolicy } from "@ling/core/pi-protocol/request-policy";
import {
	appendPiWorkerResponseChunk,
	type PiWorkerResponseChunkAccumulator,
} from "@ling/core/pi-protocol/response-stream";
import { PI_WORKER_PROTOCOL_VERSION, PI_WORKER_REQUEST_CAPACITY } from "@ling/core/pi-protocol/wire-format";
import { cleanupPiWorkerCreationContext, type PiWorkerCreationContext } from "./pi-worker-main-rpc";
import type { PendingRequestSummary, PiWorkerGeneration } from "./pi-worker-process";
import { waitForPiWorkerBarrier } from "./pi-worker-request-policy";

const log = createLogger("pi-worker-request-transport");

type RequestHost = Pick<PiWorkerGeneration, "generation"> & { port: Pick<PiWorkerGeneration["port"], "postMessage"> };

interface PiRequestContext<Host extends RequestHost> {
	host: Host;
	method: PiWorkerMethod;
	policy: PiWorkerRequestPolicy;
	deadlineAt: number;
	startedAt: number;
	responseChunks?: PiWorkerResponseChunkAccumulator;
}

type PendingHostRequest<Host extends RequestHost> = PendingRequest<unknown, PiRequestContext<Host>>;

interface PiWorkerRequestOptions<Host = PiWorkerGeneration> {
	timeoutMs?: number;
	signal?: AbortSignal;
	creation?: PiWorkerCreationContext;
	/** Target worker; the control worker when omitted. */
	host?: Promise<Host>;
}

interface PiWorkerRequestTransportOptions<Host extends RequestHost> {
	creationContexts: Map<string, PiWorkerCreationContext>;
	ensureHost(): Promise<Host>;
	failHost(host: Host, error: Error): void;
	failHostGracefully(host: Host, error: Error): void;
}

interface PiWorkerRequestTransport<Host extends RequestHost = PiWorkerGeneration> {
	call: PiCall<PiWorkerRequestOptions<Host>>;
	settleResponse(host: Host, value: unknown): void;
	rejectHost(host: Host, error: Error): void;
	activeRequestDeadline(host: Host): number | null;
	pendingRequests(host: Host): PendingRequestSummary[];
}

export function createPiWorkerRequestTransport<Host extends RequestHost>(
	options: PiWorkerRequestTransportOptions<Host>,
): PiWorkerRequestTransport<Host> {
	const pendingRequests = createPendingRequests<PiRequestContext<Host>>({
		capacity: PI_WORKER_REQUEST_CAPACITY,
		createId: (sequence) => `main-${sequence}`,
		capacityError: () =>
			requestCapacityExceeded(
				"piHostRequest",
				PI_WORKER_REQUEST_CAPACITY,
				"The Pi worker request backlog is full. Wait for an active operation to finish, then retry.",
			),
	});
	const generationFailureErrors = new WeakSet<Error>();
	const rejectHost = (host: Host, error: Error): void => {
		generationFailureErrors.add(error);
		pendingRequests.rejectWhere((context) => context.host === host, error);
	};

	const settleResult = (host: Host, requestId: string, pending: PendingHostRequest<Host>, value: unknown): void => {
		let result: unknown;
		try {
			result = parsePiWorkerOperationResult(pending.context.method, value);
		} catch (error) {
			const cause = toError(error);
			const invalidResult = new Error(
				`Pi worker returned an invalid result for ${pending.context.method}: ${cause.message}`,
				{
					cause,
				},
			);
			if (pending.context.policy.kind === "command") {
				options.failHost(host, invalidResult);
				return;
			}
			if (pendingRequests.get(requestId) !== pending) return;
			delete pending.context.responseChunks;
			log.error(`Isolated invalid Pi worker result for ${pending.context.method}:`, cause);
			pending.reject(invalidResult);
			return;
		}
		if (pendingRequests.get(requestId) !== pending) return;
		delete pending.context.responseChunks;
		pending.resolve(result);
	};

	const settleResponse = (host: Host, value: unknown): void => {
		const response = parsePiWorkerResponse(value);
		if (response.generation !== host.generation) return;
		const pending = pendingRequests.get(response.requestId);
		if (!pending || pending.context.host !== host) return;
		if (pending.context.method !== response.method) {
			throw new Error(`Pi worker response method mismatch for ${response.requestId}`);
		}
		if (response.kind === "resultChunk") {
			const appendResult = appendPiWorkerResponseChunk(pending.context.responseChunks, response);
			if (appendResult.kind === "pending") {
				pending.context.responseChunks = appendResult.accumulator;
				return;
			}
			settleResult(host, response.requestId, pending, appendResult.result);
			return;
		}
		if (pending.context.responseChunks) throw new Error(`Pi worker response stream ended with ${response.kind}`);
		if (response.kind === "result") {
			settleResult(host, response.requestId, pending, response.result);
			return;
		}
		pending.reject(piWorkerError(response.error));
	};

	const callOnce = async <Method extends PiWorkerMethod>(
		method: Method,
		params: PiRequestParams<Method>,
		requestOptions: PiWorkerRequestOptions<Host>,
		policy: PiWorkerRequestPolicy,
	): Promise<PiMethodResult<Method>> => {
		pendingRequests.assertCapacity();
		if (requestOptions.signal?.aborted) {
			throw requestOptions.signal.reason ?? new Error(`Pi worker request was cancelled: ${method}`);
		}
		const host = await waitForPiWorkerBarrier(requestOptions.host ?? options.ensureHost(), requestOptions.signal);
		if (requestOptions.signal?.aborted) {
			throw requestOptions.signal.reason ?? new Error(`Pi worker request was cancelled: ${method}`);
		}
		pendingRequests.assertCapacity();
		if (requestOptions.creation) requestOptions.creation.hostGeneration = host.generation;
		const requestId = pendingRequests.allocateId();
		const timeoutMs = requestOptions.timeoutMs ?? policy.timeoutMs;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error(`Pi worker request timeout is invalid: ${method}`);
		}
		const deadlineAt = Date.now() + timeoutMs;
		if (requestOptions.creation) options.creationContexts.set(requestId, requestOptions.creation);
		const pending = pendingRequests.create<PiMethodResult<Method>>({
			id: requestId,
			context: { host, method, policy, deadlineAt, startedAt: Date.now() },
			deadline: { at: deadlineAt, error: () => new Error(`Pi worker request timed out: ${method}`) },
			...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
			abortError: (signal) => toError(signal.reason ?? new Error(`Pi worker request cancelled: ${method}`)),
			onExpired(reason, error) {
				try {
					host.port.postMessage({
						kind: "cancel",
						protocolVersion: PI_WORKER_PROTOCOL_VERSION,
						generation: host.generation,
						requestId,
					});
				} catch (postError) {
					options.failHost(host, reason === "deadline" ? error : toError(postError));
					return;
				}
				if (reason === "deadline" && policy.kind === "command") options.failHostGracefully(host, error);
			},
		});
		const operation = pending.promise;
		if (pendingRequests.get(requestId) === pending) {
			const request: PiWorkerRequest = {
				kind: "request",
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation: host.generation,
				requestId,
				method,
				deadlineAt,
				params,
			};
			try {
				host.port.postMessage(request);
			} catch (error) {
				const transportError = toError(error);
				pending.reject(transportError);
				options.failHost(host, transportError);
			}
		}
		if (!requestOptions.creation) return operation;
		return operation.then(
			(result) => {
				options.creationContexts.delete(requestId);
				return result;
			},
			(error: unknown) => {
				const operationError = toError(error);
				options.creationContexts.delete(requestId);
				try {
					cleanupPiWorkerCreationContext(requestOptions.creation as PiWorkerCreationContext);
				} catch (cleanupError) {
					throw new AggregateError(
						[operationError, cleanupError],
						`Failed to release Pi runtime creation ${requestId}`,
					);
				}
				throw operationError;
			},
		);
	};

	const call = async <Method extends PiWorkerMethod>(
		method: Method,
		params: PiRequestParams<Method>,
		requestOptions: PiWorkerRequestOptions<Host> = {},
	): Promise<PiMethodResult<Method>> => {
		const policy = piMethods[method].policy;
		try {
			return await callOnce(method, params, requestOptions, policy);
		} catch (error) {
			const failure = toError(error);
			if (
				policy.kind !== "recoverableQuery" ||
				requestOptions.host !== undefined ||
				requestOptions.creation !== undefined ||
				requestOptions.signal?.aborted === true ||
				!generationFailureErrors.has(failure)
			) {
				throw failure;
			}
			log.warn(`Retrying ${method} once after its Pi worker generation failed`);
			return callOnce(method, params, requestOptions, policy);
		}
	};

	return {
		call,
		settleResponse,
		rejectHost,
		pendingRequests(host) {
			const now = Date.now();
			const summaries: PendingRequestSummary[] = [];
			for (const pending of pendingRequests.values()) {
				if (pending.context.host !== host) continue;
				summaries.push({ method: pending.context.method, ageMs: now - pending.context.startedAt });
			}
			return summaries;
		},
		activeRequestDeadline(host) {
			let deadline: number | null = null;
			for (const pending of pendingRequests.values()) {
				if (pending.context.host !== host || !pending.context.policy.deferHeartbeat) continue;
				deadline = deadline === null ? pending.context.deadlineAt : Math.max(deadline, pending.context.deadlineAt);
			}
			return deadline;
		},
	};
}
