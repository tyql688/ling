import type { ProjectTrustChoice } from "@ling/contracts/project";
import type { CompanionToolCall, CompanionToolResult, PiAdapterPlan } from "@ling/contracts/companions";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import type { PiTurnLifecycleHost } from "@ling/core/pi-protocol/turn-review";
import type { ExtensionUiBridge, ExtensionUiRequester } from "@ling/core/pi-protocol/extension-ui";
import { throwAggregateFailures } from "@ling/core/ling-error";
import { pathIdentity } from "@ling/core/paths";
import { piCallbacks } from "@ling/core/pi-protocol/callback-methods";
import { dispatchPiMethod, type PiMethodHandlers } from "@ling/core/pi-protocol/method";
import type { PiWorkerMainRequest, PiWorkerRuntimeEvent } from "@ling/core/pi-protocol/protocol";
import {
	createPiWorkerReplacementReservation,
	type PiWorkerReplacementReservation,
} from "@ling/core/pi-protocol/replacement-reservation";
import type { PiWorkerRemoteRuntime } from "@ling/host/workers/pi/pi-worker-session-runtime";
import type { BeforeBindSession, SessionRuntimeBindingCleanup } from "@ling/core/pi-protocol/runtime-provider";
import { randomUUID } from "node:crypto";

const REPLACEMENT_RESERVATION_CAPACITY = 64;

export interface PiWorkerCreationContext {
	runtimeId: string;
	expectedCwd: string;
	hostGeneration?: number;
	beforeBind?: BeforeBindSession;
	boundRefs: Map<string, { ref: SessionRef; release?: SessionRuntimeBindingCleanup }>;
	pendingEvents: PiWorkerRuntimeEvent[];
}

interface PiWorkerMainRpcOptions {
	extensionUi: ExtensionUiBridge;
	runPluginTool(value: unknown, signal: AbortSignal): Promise<string>;
	invokeCompanionTool(call: CompanionToolCall, signal: AbortSignal): Promise<CompanionToolResult>;
	readAdapterPlan(cwd: string): Promise<PiAdapterPlan>;
	getRuntime(runtimeId: string): PiWorkerRemoteRuntime | undefined;
	getCreation(requestId: string): PiWorkerCreationContext | undefined;
	promptProjectTrust(cwd: string, signal?: AbortSignal): Promise<ProjectTrustChoice | null>;
	turnLifecycleHost: PiTurnLifecycleHost;
}

export interface PiWorkerMainRpc {
	handle(request: PiWorkerMainRequest, signal: AbortSignal): Promise<unknown>;
	abortRequest(generation: number, requestId: string): Promise<void>;
	abortGeneration(generation: number): Promise<void>;
}

interface StoredReplacementReservation {
	prepareRequestKey: string;
	reservation: PiWorkerReplacementReservation;
}

export function cleanupPiWorkerCreationContext(context: PiWorkerCreationContext): void {
	const failures: unknown[] = [];
	for (const binding of context.boundRefs.values()) {
		try {
			binding.release?.();
		} catch (error) {
			failures.push(error);
		}
	}
	context.boundRefs.clear();
	context.pendingEvents.length = 0;
	throwAggregateFailures(failures, "Failed to release Pi worker creation bindings");
}

export function createPiWorkerMainRpc(options: PiWorkerMainRpcOptions): PiWorkerMainRpc {
	const { getApprovalRequester, getExtensionUiRequester } = options.extensionUi;

	const reservations = new Map<string, StoredReplacementReservation>();
	const reservationIdsByPrepareRequest = new Map<string, string>();
	const preparingRequests = new Set<string>();

	const prepareGenerationPrefix = (generation: number): string => `${generation}\0`;
	const prepareRequestKey = (generation: number, requestId: string): string =>
		`${prepareGenerationPrefix(generation)}${requestId}`;

	const deleteReservation = (reservationId: string): StoredReplacementReservation | undefined => {
		const stored = reservations.get(reservationId);
		if (!stored) return undefined;
		reservations.delete(reservationId);
		if (reservationIdsByPrepareRequest.get(stored.prepareRequestKey) === reservationId) {
			reservationIdsByPrepareRequest.delete(stored.prepareRequestKey);
		}
		return stored;
	};

	const requireRuntime = (runtimeId: string): PiWorkerRemoteRuntime => {
		const parsed = runtimeId;
		const runtime = options.getRuntime(parsed);
		if (!runtime) throw new Error(`Unknown Pi worker runtime: ${parsed}`);
		return runtime;
	};

	const requireReservation = (reservationId: string): [string, PiWorkerReplacementReservation] => {
		const id = reservationId;
		const stored = reservations.get(id);
		if (!stored) throw new Error(`Unknown Pi worker replacement reservation: ${id}`);
		return [id, stored.reservation];
	};

	const handlers: PiMethodHandlers<typeof piCallbacks, { request: PiWorkerMainRequest; signal: AbortSignal }> = {
		"companions.invoke": async (params, { signal }) => options.invokeCompanionTool(params, signal),
		"runtime.beforeBind": async (params, { request, signal }) => {
			const creationRequestId = params.creationRequestId;
			const runtimeId = params.runtimeId;
			const ref = params.ref;
			const context = options.getCreation(creationRequestId);
			if (!context || context.runtimeId !== runtimeId || context.hostGeneration !== request.generation) {
				throw new Error("Pi worker runtime creation is no longer active");
			}
			if (pathIdentity(ref.cwd) !== pathIdentity(context.expectedCwd)) {
				throw new Error("Pi worker runtime creation returned a session from a different project");
			}
			const key = sessionKey(ref);
			if (context.boundRefs.has(key)) throw new Error("Pi worker runtime creation bound the same session twice");
			const binding: { ref: SessionRef; release?: SessionRuntimeBindingCleanup } = { ref: { ...ref } };
			context.boundRefs.set(key, binding);
			const release = await context.beforeBind?.(ref);
			const stillOwned =
				!signal.aborted && options.getCreation(creationRequestId) === context && context.boundRefs.get(key) === binding;
			if (!stillOwned) {
				const ownershipError =
					signal.reason instanceof Error
						? signal.reason
						: new Error("Pi worker runtime creation ended before its binding completed");
				if (!release) throw ownershipError;
				try {
					release();
				} catch (cleanupError) {
					throw new AggregateError(
						[ownershipError, cleanupError],
						"Failed to release a late Pi worker runtime binding",
					);
				}
				throw ownershipError;
			}
			if (release) binding.release = release;
			return null;
		},
		"runtime.prepareReplacement": async (params, { request, signal }) => {
			if (reservations.size + preparingRequests.size >= REPLACEMENT_RESERVATION_CAPACITY) {
				throw new Error("Pi worker replacement reservation capacity is full");
			}
			const runtime = requireRuntime(params.runtimeId);
			const event = {
				previousRef: params.event.previousRef,
				nextRef: params.event.nextRef,
				reason: params.event.reason,
			};
			const requestKey = prepareRequestKey(request.generation, request.requestId);
			preparingRequests.add(requestKey);
			try {
				const reservation = await runtime.prepareReplacement(event);
				if (signal.aborted) {
					await reservation.abort();
					throw signal.reason;
				}
				const reservationId = `replacement-${randomUUID()}`;
				reservations.set(reservationId, {
					prepareRequestKey: requestKey,
					reservation: createPiWorkerReplacementReservation(request.generation, runtime.runtimeId, reservation),
				});
				reservationIdsByPrepareRequest.set(requestKey, reservationId);
				return { reservationId };
			} finally {
				preparingRequests.delete(requestKey);
			}
		},
		"runtime.commitReplacement": async (params, { request }) => {
			const [reservationId, reservation] = requireReservation(params.reservationId);
			if (reservation.generation !== request.generation) throw new Error("Stale Pi worker replacement reservation");
			await reservation.commit();
			deleteReservation(reservationId);
			return null;
		},
		"runtime.abortReplacement": async (params, { request }) => {
			const [reservationId, reservation] = requireReservation(params.reservationId);
			if (reservation.generation !== request.generation) throw new Error("Stale Pi worker replacement reservation");
			try {
				await reservation.abort();
			} finally {
				deleteReservation(reservationId);
			}
			return null;
		},
		"extension.confirm": async (params, { signal }) => {
			const ref = params.ref;
			const requester = getApprovalRequester(ref);
			if (!requester) throw new Error(`Approval requester is unavailable for ${ref.sessionId}`);
			return requester({
				ref,
				title: params.title,
				message: params.message,
				options: { signal, ...(params.timeout === undefined ? {} : { timeout: params.timeout }) },
			});
		},
		"extension.prompt": async (params, { signal }) => {
			const ref = params.ref;
			const requester = getExtensionUiRequester(ref);
			if (!requester) throw new Error(`Extension UI requester is unavailable for ${ref.sessionId}`);
			const rawPrompt = params.prompt;
			const promptOptions = {
				signal,
				...(rawPrompt.timeout === undefined ? {} : { timeout: rawPrompt.timeout }),
			};
			let prompt: Parameters<ExtensionUiRequester>[1];
			if (rawPrompt.kind === "select") {
				prompt = {
					kind: rawPrompt.kind,
					title: rawPrompt.title,
					options: rawPrompt.options,
					promptOptions,
				};
			} else if (rawPrompt.kind === "input") {
				prompt = {
					kind: rawPrompt.kind,
					title: rawPrompt.title,
					placeholder: rawPrompt.placeholder,
					promptOptions,
				};
			} else {
				prompt = {
					kind: rawPrompt.kind,
					title: rawPrompt.title,
					initialValue: rawPrompt.initialValue,
					promptOptions,
				};
			}
			return (await requester(ref, prompt)) ?? null;
		},
		"turn.start": async (params, _context) => {
			const ref = params.ref;
			await options.turnLifecycleHost.start(ref, params.timestamp, params.context);
			return null;
		},
		"turn.finish": async (params, _context) => {
			const ref = params.ref;
			await options.turnLifecycleHost.finish(
				ref,
				params.timestamp,
				{
					files: params.fallback.files,
					failureCode: params.fallback.failureCode,
				},
				params.context,
			);
			return null;
		},
		"plugins.run": async (params, { signal }) => {
			return options.runPluginTool(params, signal);
		},
		"adapters.read": async ({ cwd }) => options.readAdapterPlan(cwd),
		"project.promptTrust": async (params, { signal }) => {
			return options.promptProjectTrust(params.cwd, signal);
		},
	};
	const handle = async (request: PiWorkerMainRequest, signal: AbortSignal): Promise<unknown> => {
		if (signal.aborted) throw signal.reason;
		return dispatchPiMethod(piCallbacks, handlers, request.method, request.params, { request, signal });
	};

	return {
		handle,
		async abortRequest(generation, requestId) {
			const requestKey = prepareRequestKey(generation, requestId);
			preparingRequests.delete(requestKey);
			const reservationId = reservationIdsByPrepareRequest.get(requestKey);
			if (!reservationId) return;
			const stored = deleteReservation(reservationId);
			if (stored) await stored.reservation.abort();
		},
		async abortGeneration(generation) {
			const preparingPrefix = prepareGenerationPrefix(generation);
			for (const requestKey of preparingRequests) {
				if (requestKey.startsWith(preparingPrefix)) preparingRequests.delete(requestKey);
			}
			const targets: PiWorkerReplacementReservation[] = [];
			for (const [reservationId, stored] of reservations) {
				if (stored.reservation.generation !== generation) continue;
				targets.push(stored.reservation);
				deleteReservation(reservationId);
			}
			const results = await Promise.allSettled(
				targets.map((reservation) => Promise.resolve().then(() => reservation.abort())),
			);
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			throwAggregateFailures(failures, `Failed to abort Pi worker generation ${generation} reservations`);
		},
	};
}
