import { requestCapacityExceeded } from "@ling/core/ling-error";
import { randomUUID } from "node:crypto";

interface PairedDialogHandle<TRequest extends { requestId: string }, TResponse> {
	request: TRequest;
	response: Promise<TResponse>;
	respond: (response: TResponse) => boolean;
}

interface PairedDialog<TPayload, TRequest extends { requestId: string }, TResponse> {
	request: (payload: TPayload) => Promise<TResponse>;
	requestWithHandle: (payload: TPayload) => PairedDialogHandle<TRequest, TResponse>;
	respond: (requestId: string, response: TResponse) => boolean;
	respondOrThrow: (requestId: string, response: TResponse) => void;
	pending: () => TRequest[];
	clearWhere: (predicate: (request: TRequest) => boolean, response: TResponse) => void;
}

export function createPairedDialog<TPayload, TRequest extends { requestId: string }, TResponse>(options: {
	buildRequest: (requestId: string, payload: TPayload) => TRequest;
	send: (request: TRequest) => void;
	/** Backpressure for dialogs whose producer is external (Pi extensions); omit for Ling-driven dialogs. */
	maxPending?: { limit: number; resource: string; message: string };
}): PairedDialog<TPayload, TRequest, TResponse> {
	const pending = new Map<string, { request: TRequest; resolve: (response: TResponse) => void }>();

	return {
		request(payload) {
			return this.requestWithHandle(payload).response;
		},
		requestWithHandle(payload) {
			const maxPending = options.maxPending;
			if (maxPending && pending.size >= maxPending.limit) {
				throw requestCapacityExceeded(maxPending.resource, maxPending.limit, maxPending.message);
			}
			const requestId = randomUUID();
			const request = options.buildRequest(requestId, payload);
			if (!requestId || request.requestId !== requestId) {
				throw new Error("Paired dialog request builder changed or omitted its generated requestId");
			}
			if (pending.has(requestId)) throw new Error(`Duplicate pending dialog requestId: ${requestId}`);
			const response = new Promise<TResponse>((resolve) => {
				pending.set(requestId, { request, resolve });
			});
			try {
				options.send(request);
			} catch (error) {
				pending.delete(requestId);
				throw error;
			}
			return {
				request,
				response,
				respond: (dialogResponse) => this.respond(request.requestId, dialogResponse),
			};
		},
		respond(requestId, response) {
			const entry = pending.get(requestId);
			if (!entry) return false;
			pending.delete(requestId);
			entry.resolve(response);
			return true;
		},
		respondOrThrow(requestId, response) {
			if (!this.respond(requestId, response)) {
				throw new Error(`Unknown or expired dialog request: ${requestId}`);
			}
		},
		pending() {
			return [...pending.values()].map((entry) => entry.request);
		},
		clearWhere(predicate, response) {
			for (const [requestId, entry] of pending) {
				if (!predicate(entry.request)) continue;
				pending.delete(requestId);
				entry.resolve(response);
			}
		},
	};
}
