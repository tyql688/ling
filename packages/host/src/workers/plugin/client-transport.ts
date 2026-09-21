import { createPendingRequests } from "@ling/contracts/protocol/pending-requests";
import { createWorkerRpc } from "../worker-rpc";
import type { PluginProgressEvent } from "@ling/contracts/plugin";
import {
	createLingError,
	requestCancelled,
	throwAggregateFailures,
	throwIfOperationAborted,
	toError,
} from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import {
	type PluginHostErrorDto,
	type PluginHostRequestPayload,
	type PluginHostResponse,
	type PluginHostEvent,
	type PluginHostSpawner,
	type PluginHostTransport,
	PLUGIN_HOST_RESPONSE_MAX_BYTES,
	parsePluginHostResponse,
	parsePluginHostEvent,
} from "@ling/core/plugin-host/protocol";

const log = createLogger("plugin-host-client");

type ProgressListener = (event: PluginProgressEvent) => void;

interface LatePluginMutationSettlement {
	cwd: string;
	method: "install" | "remove" | "update";
	outcome: "completed" | "failed";
}

type LateMutationSettlementListener = (settlement: LatePluginMutationSettlement) => void;

interface PluginRequestContext {
	method: PluginHostRequestPayload["method"];
	mutation: boolean;
	cwd: string;
	waitId: string;
	admitted: boolean;
	state: "pending" | "awaitingLateMutationSettlement" | "settled";
}
type PluginRpc = ReturnType<
	typeof createWorkerRpc<PluginHostRequestPayload, PluginHostResponse, PluginHostEvent, PluginRequestContext>
>;

const IDLE_SHUTDOWN_MS = 60_000;
const PLUGIN_HOST_LATE_MUTATION_SETTLEMENT_MS = 60_000;
const PLUGIN_HOST_ADMISSION_LIMITS = Object.freeze({
	reads: 28,
	mutations: 4,
});

function hostResponseError(error: PluginHostErrorDto): Error {
	// An uncertain write must retain its reconciliation semantics even when a cause is known.
	if (error.outcome === "knownFailed" && error.cause) return createLingError(error.cause);
	if (error.code === "INVALID_REQUEST") {
		return createLingError({
			code: "INVALID_REQUEST",
			category: "validation",
			message: error.message,
			retryable: false,
		});
	}
	if (error.code === "REQUEST_DEADLINE_EXCEEDED") {
		return createLingError({
			code: "REQUEST_DEADLINE_EXCEEDED",
			category: "lifecycle",
			message: error.message,
			retryable: true,
			userAction: "retry",
		});
	}
	return createLingError({
		code: error.outcome === "unknown" ? "PACKAGE_OPERATION_UNCERTAIN" : "PACKAGE_OPERATION_FAILED",
		category: "external",
		message: error.message,
		retryable: error.retryable,
		userAction: error.outcome === "unknown" ? "report" : "retry",
	});
}

function abortReason(signal: AbortSignal): Error {
	try {
		throwIfOperationAborted(signal);
	} catch (error) {
		return toError(error);
	}
	return new Error("Plugin operation was not aborted");
}

function isMutationMethod(method: PluginHostRequestPayload["method"]): boolean {
	return method === "install" || method === "remove" || method === "update";
}

export function createPluginHostTransport(spawner: PluginHostSpawner) {
	let disposing = false;
	let disposal: Promise<void> | null = null;
	const retiringHosts = new Map<PluginHostTransport, Promise<void>>();

	const listeners = new Set<ProgressListener>();
	const lateMutationSettlementListeners = new Set<LateMutationSettlementListener>();

	let transport: PluginHostTransport | null = null;
	const rpcByTransport = new WeakMap<PluginHostTransport, PluginRpc>();
	const callerRequests = createPendingRequests<PluginRequestContext>({
		capacity: PLUGIN_HOST_ADMISSION_LIMITS.reads + PLUGIN_HOST_ADMISSION_LIMITS.mutations,
		capacityError: () => new Error("Plugin caller capacity is full"),
		createId: (sequence) => `plugin-wait-${sequence}`,
	});
	function rpcFor(spawned: PluginHostTransport): PluginRpc {
		const rpc = rpcByTransport.get(spawned);
		if (!rpc) throw new Error("Plugin transport has no RPC owner");
		return rpc;
	}
	function pendingEntries(spawned = transport): PluginRequestContext[] {
		// No transport means no admitted worker calls; retired transports are queried explicitly during cleanup.
		return spawned ? [...rpcFor(spawned).values()].map((request) => request.context) : [];
	}

	let idleTimer: NodeJS.Timeout | null = null;

	function retireHost(spawned: PluginHostTransport): Promise<void> {
		const existing = retiringHosts.get(spawned);
		if (existing) return existing;
		const stopped = Promise.resolve()
			.then(() => spawned.kill())
			.finally(() => retiringHosts.delete(spawned));
		retiringHosts.set(spawned, stopped);
		return stopped;
	}
	function terminateHost(spawned: PluginHostTransport, reason: string): void {
		void retireHost(spawned).catch((error: unknown) => {
			log.error(`failed to terminate plugin host process tree (${reason})`, error);
		});
	}

	function hasPendingMutation(): boolean {
		for (const entry of pendingEntries()) {
			if (entry.mutation) return true;
		}
		return false;
	}

	function shutdownPluginHost(): Promise<void> {
		if (disposal) return disposal;
		disposing = true;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
		lateMutationSettlementListeners.clear();
		listeners.clear();
		const active = transport;
		if (active) {
			rejectAllForTransportLoss(active, "application shutdown");
			// Capture retirement before awaiting so every previously detached child is drained too.
			void retireHost(active).catch((error: unknown) => log.error("plugin host shutdown failed", error));
		}
		disposal = Promise.allSettled([...retiringHosts.values()]).then((results) => {
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to dispose plugin host transports",
			);
		});
		return disposal;
	}

	function armIdleShutdown(): void {
		if (disposing) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (pendingEntries().length > 0 || !transport) return;
			log.info("shutting down idle plugin host");
			const idle = transport;
			transport = null;
			terminateHost(idle, "idle shutdown");
		}, IDLE_SHUTDOWN_MS);
		idleTimer.unref();
	}

	function notifyLateMutationSettlement(
		entry: PluginRequestContext,
		outcome: LatePluginMutationSettlement["outcome"],
	): void {
		if (!entry.mutation) return;
		const method = entry.method;
		if (method !== "install" && method !== "remove" && method !== "update") return;
		const settlement = { cwd: entry.cwd, method, outcome } satisfies LatePluginMutationSettlement;
		for (const listener of lateMutationSettlementListeners) {
			try {
				listener(settlement);
			} catch (error) {
				log.error("late plugin mutation settlement listener failed", error);
			}
		}
	}

	function transportLossError(entry: Pick<PluginRequestContext, "mutation">, reason: string): Error {
		return createLingError({
			code: entry.mutation ? "PACKAGE_OPERATION_UNCERTAIN" : "PACKAGE_HOST_LOST",
			category: "external",
			message: entry.mutation
				? `The package host stopped after a mutation was admitted (${reason}); Ling must reconcile Pi state.`
				: `The package host stopped before the read completed (${reason}).`,
			retryable: !entry.mutation,
			userAction: entry.mutation ? "report" : "retry",
		});
	}
	function rejectAllForTransportLoss(spawned: PluginHostTransport, reason: string): void {
		const entries = pendingEntries(spawned);
		if (transport === spawned) transport = null;
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
		for (const entry of entries) {
			const late = entry.state === "awaitingLateMutationSettlement";
			entry.state = "settled";
			if (late) notifyLateMutationSettlement(entry, "failed");
			else callerRequests.get(entry.waitId)?.reject(transportLossError(entry, reason));
		}
		rpcFor(spawned).close(new Error(`Package transport lost: ${reason}`));
	}

	function notifyProgress(event: PluginProgressEvent): void {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (error) {
				log.error("plugin host progress listener failed", error);
			}
		}
	}

	function getTransport(): PluginHostTransport {
		if (transport) return transport;
		if (disposing) throw requestCancelled("The plugin host transport has been disposed.");
		const spawned = spawner();
		const rpc = createWorkerRpc<PluginHostRequestPayload, PluginHostResponse, PluginHostEvent, PluginRequestContext>({
			capacity: PLUGIN_HOST_ADMISSION_LIMITS.reads + PLUGIN_HOST_ADMISSION_LIMITS.mutations,
			capacityError: () => new Error("Plugin worker capacity is full"),
			maxFrameBytes: PLUGIN_HOST_RESPONSE_MAX_BYTES,
			post: (value) => spawned.postMessage(value),
			onMessage: (listener) => spawned.onMessage(listener),
			receiveEvent(value) {
				if (transport !== spawned) return;
				const event = parsePluginHostEvent(value);
				if (rpc.get(event.id)?.context.state === "pending") notifyProgress(event.event);
			},
			parseResponse(value, payload) {
				try {
					const response = parsePluginHostResponse(value);
					if (response.method !== payload.method) throw new Error("Package response method mismatch");
					return response;
				} catch (error) {
					log.error("plugin host returned an invalid response", error);
					rejectAllForTransportLoss(spawned, "invalid response");
					terminateHost(spawned, "invalid response");
					throw transportLossError({ mutation: isMutationMethod(payload.method) }, "invalid response");
				}
			},
			onError(error) {
				log.error("plugin host returned an invalid protocol message", error);
				rejectAllForTransportLoss(spawned, "invalid protocol message");
				terminateHost(spawned, "invalid protocol message");
			},
		});
		rpcByTransport.set(spawned, rpc);
		spawned.onExit((code) => {
			if (transport !== spawned) return;
			const reason = `exit code ${code ?? "unknown"}`;
			log.error(`plugin host exited unexpectedly (${reason})`);
			rejectAllForTransportLoss(spawned, reason);
		});
		transport = spawned;
		return spawned;
	}

	function assertPluginHostCapacity(mutation: boolean): void {
		let matchingPending = 0;
		for (const entry of pendingEntries()) {
			if (entry.mutation === mutation) matchingPending += 1;
		}
		const capacity = mutation ? PLUGIN_HOST_ADMISSION_LIMITS.mutations : PLUGIN_HOST_ADMISSION_LIMITS.reads;
		if (matchingPending < capacity) return;
		throw createLingError({
			code: "REQUEST_CAPACITY_EXCEEDED",
			category: "lifecycle",
			message: mutation
				? "The package host mutation queue is full. Wait for an active package change to finish, then retry."
				: "The package host read queue is full. Wait for an active package read to finish, then retry.",
			retryable: true,
			userAction: "retry",
			details: {
				resource: mutation ? "packageHostMutation" : "packageHostRead",
				capacity,
			},
		});
	}

	function requestPluginHost<Result>(payload: PluginHostRequestPayload, signal?: AbortSignal): Promise<Result> {
		throwIfOperationAborted(signal);
		if (disposing) throw requestCancelled("The plugin host transport has been disposed.");
		if (Date.now() >= payload.deadlineAt)
			throw createLingError({
				code: "REQUEST_DEADLINE_EXCEEDED",
				category: "lifecycle",
				message: "The package host request deadline has expired.",
				retryable: true,
				userAction: "retry",
			});
		const mutation = isMutationMethod(payload.method);
		assertPluginHostCapacity(mutation);
		const active = getTransport();
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
		const waitId = callerRequests.allocateId();
		const entry: PluginRequestContext = {
			method: payload.method,
			mutation,
			cwd: payload.cwd,
			waitId,
			admitted: false,
			state: "pending",
		};
		const caller = callerRequests.create<Result>({
			id: waitId,
			context: entry,
			deadline: {
				at: payload.deadlineAt,
				error: () =>
					createLingError({
						code: mutation ? "PACKAGE_OPERATION_UNCERTAIN" : "REQUEST_DEADLINE_EXCEEDED",
						category: mutation ? "external" : "lifecycle",
						message: mutation
							? "The package mutation exceeded its deadline after admission; Ling must reconcile Pi state."
							: "The package host read exceeded its deadline.",
						retryable: !mutation,
						userAction: mutation ? "report" : "retry",
					}),
			},
			// Once posted, package mutations cannot be cancelled safely; their live reconciliation owns completion.
			...(signal && !mutation ? { signal, abortError: abortReason } : {}),
			onExpired(reason) {
				entry.state = mutation && entry.admitted ? "awaitingLateMutationSettlement" : "settled";
				if (!entry.admitted) {
					if (pendingEntries().length === 0) armIdleShutdown();
					return;
				}
				if (!mutation && transport === active && !hasPendingMutation()) {
					rejectAllForTransportLoss(active, reason === "abort" ? "read cancelled" : "read deadline");
					terminateHost(active, reason === "abort" ? "read cancelled" : "read deadline");
				}
			},
		});
		if (callerRequests.get(waitId) !== caller) return caller.promise;
		// The caller deadline and worker settlement are distinct: admitted writes keep their
		// RPC alive for the existing grace period so late success/failure still reconciles resources.
		void rpcFor(active)
			.call(payload, {
				context: entry,
				deadline: {
					at: payload.deadlineAt + (mutation ? PLUGIN_HOST_LATE_MUTATION_SETTLEMENT_MS : 0),
					error: () => new Error("Package worker settlement deadline exceeded"),
				},
				...(signal && !mutation ? { signal, abortError: abortReason } : {}),
				onAdmitted() {
					throwIfOperationAborted(signal);
					entry.admitted = true;
				},
				onExpired(reason) {
					if (mutation && reason === "deadline") {
						log.error("plugin mutation did not settle within its post-deadline grace period");
						rejectAllForTransportLoss(active, "mutation settlement grace exceeded");
						terminateHost(active, "mutation settlement grace exceeded");
					}
				},
			})
			.then(
				(response) => {
					const late = entry.state === "awaitingLateMutationSettlement";
					const pending = entry.state === "pending";
					entry.state = "settled";
					if (late) notifyLateMutationSettlement(entry, response.kind === "result" ? "completed" : "failed");
					else if (pending) {
						if (response.kind === "result") callerRequests.get(waitId)?.resolve(response.result);
						else callerRequests.get(waitId)?.reject(hostResponseError(response.error));
					}
				},
				(error: unknown) => {
					const late = entry.state === "awaitingLateMutationSettlement";
					const pending = entry.state === "pending";
					entry.state = "settled";
					if (late) notifyLateMutationSettlement(entry, "failed");
					else if (pending) callerRequests.get(waitId)?.reject(toError(error));
				},
			)
			.finally(() => {
				if (pendingEntries().length === 0) armIdleShutdown();
			});
		return caller.promise;
	}

	function onPackageManagerProgress(listener: ProgressListener): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	function onLatePluginMutationSettlement(listener: LateMutationSettlementListener): () => void {
		lateMutationSettlementListeners.add(listener);
		return () => lateMutationSettlementListeners.delete(listener);
	}
	return { requestPluginHost, onPackageManagerProgress, onLatePluginMutationSettlement, dispose: shutdownPluginHost };
}

export type PluginHostClientTransport = ReturnType<typeof createPluginHostTransport>;
