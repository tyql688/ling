import { toError } from "@ling/core/ling-error";
import { schedulePiWorkerDeadline } from "@ling/core/pi-protocol/deadline";
import type { PiWorkerMainRequest, PiWorkerMainResponse } from "@ling/core/pi-protocol/protocol";
import { PI_WORKER_PROTOCOL_VERSION, PI_WORKER_REVERSE_REQUEST_CAPACITY } from "@ling/core/pi-protocol/wire-format";
import {
	parsePiWorkerCancel,
	parsePiWorkerMainRequest,
	piWorkerErrorDto,
} from "@ling/core/pi-protocol/protocol-validation";
import type { PiWorkerMainRpc } from "./pi-worker-main-rpc";
import type { PiWorkerGeneration } from "./pi-worker-process";

interface ActiveMainRequest {
	host: PiWorkerGeneration;
	method: PiWorkerMainRequest["method"];
	controller: AbortController;
	cancelTimer(): void;
}

interface PiWorkerMainRequestHandlerOptions {
	rpc: PiWorkerMainRpc;
	failHost(host: PiWorkerGeneration, error: Error): void;
}

interface PiWorkerMainRequestHandler {
	handle(host: PiWorkerGeneration, value: unknown): void;
	cancel(host: PiWorkerGeneration, value: unknown): void;
	abortHost(host: PiWorkerGeneration, error: Error): void;
}

export function createPiWorkerMainRequestHandler(
	options: PiWorkerMainRequestHandlerOptions,
): PiWorkerMainRequestHandler {
	const activeRequests = new Map<string, ActiveMainRequest>();

	const abortRpcRequest = (host: PiWorkerGeneration, requestId: string): void => {
		void options.rpc.abortRequest(host.generation, requestId).catch((error: unknown) => {
			options.failHost(
				host,
				new Error(`Failed to cancel Pi worker Main request state: ${requestId}`, { cause: error }),
			);
		});
	};

	const postResponse = (host: PiWorkerGeneration, response: PiWorkerMainResponse): void => {
		if (host.failed || host.exited) return;
		try {
			host.port.postMessage(response);
		} catch (error) {
			options.failHost(host, toError(error));
		}
	};

	const handle = (host: PiWorkerGeneration, value: unknown): void => {
		const request = parsePiWorkerMainRequest(value);
		if (request.generation !== host.generation) return;
		if (activeRequests.size >= PI_WORKER_REVERSE_REQUEST_CAPACITY || activeRequests.has(request.requestId)) {
			postResponse(host, {
				kind: "mainError",
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation: host.generation,
				requestId: request.requestId,
				method: request.method,
				error: {
					code: "REQUEST_CAPACITY_EXCEEDED",
					message: "Pi worker reverse-request capacity is full",
					retryable: true,
				},
			});
			return;
		}
		if (request.deadlineAt !== null && Date.now() > request.deadlineAt) {
			postResponse(host, {
				kind: "mainError",
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation: host.generation,
				requestId: request.requestId,
				method: request.method,
				error: {
					code: "REQUEST_DEADLINE_EXCEEDED",
					message: `Pi worker reverse-request deadline exceeded: ${request.method}`,
					retryable: true,
				},
			});
			return;
		}
		const controller = new AbortController();
		const active: ActiveMainRequest = {
			host,
			method: request.method,
			controller,
			cancelTimer: () => undefined,
		};
		if (request.deadlineAt !== null) {
			active.cancelTimer = schedulePiWorkerDeadline(request.deadlineAt, () => {
				if (activeRequests.get(request.requestId) !== active) return;
				activeRequests.delete(request.requestId);
				controller.abort(new Error(`Pi worker reverse-request timed out: ${request.method}`));
				abortRpcRequest(host, request.requestId);
			});
		}
		activeRequests.set(request.requestId, active);
		const isCurrent = (): boolean =>
			activeRequests.get(request.requestId) === active && !controller.signal.aborted && !host.failed && !host.exited;
		void options.rpc
			.handle(request, controller.signal)
			.then(
				(result) => {
					if (!isCurrent()) return;
					postResponse(host, {
						kind: "mainResult",
						protocolVersion: PI_WORKER_PROTOCOL_VERSION,
						generation: host.generation,
						requestId: request.requestId,
						method: request.method,
						result,
					});
				},
				(error: unknown) => {
					if (!isCurrent()) return;
					postResponse(host, {
						kind: "mainError",
						protocolVersion: PI_WORKER_PROTOCOL_VERSION,
						generation: host.generation,
						requestId: request.requestId,
						method: request.method,
						error: piWorkerErrorDto(error, "PI_HOST_MAIN_REQUEST_FAILED"),
					});
				},
			)
			.finally(() => {
				const current = activeRequests.get(request.requestId);
				if (current?.controller === controller) activeRequests.delete(request.requestId);
				active.cancelTimer();
			});
	};

	const cancel = (host: PiWorkerGeneration, value: unknown): void => {
		const cancellation = parsePiWorkerCancel(value);
		if (cancellation.kind !== "mainCancel" || cancellation.generation !== host.generation) return;
		const active = activeRequests.get(cancellation.requestId);
		if (active?.host === host) {
			activeRequests.delete(cancellation.requestId);
			active.cancelTimer();
			active.controller.abort(new Error(`Pi worker cancelled Main request: ${active.method}`));
		}
		abortRpcRequest(host, cancellation.requestId);
	};

	const abortHost = (host: PiWorkerGeneration, error: Error): void => {
		for (const [requestId, active] of activeRequests) {
			if (active.host !== host) continue;
			activeRequests.delete(requestId);
			active.cancelTimer();
			active.controller.abort(error);
		}
	};

	return { handle, cancel, abortHost };
}
