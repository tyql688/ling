import type { UsageRangeDays, UsageStatsSnapshot } from "@ling/contracts/usage";
import { sanitizeChildProcessEnvironment } from "@ling/host/runtime/child-process-environment";
import { isLingError, requestCapacityExceeded, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import {
	parseUsageHostRequest,
	parseUsageHostResponse,
	USAGE_HOST_PROTOCOL_VERSION,
	USAGE_HOST_RESPONSE_MAX_BYTES,
	type UsageHostRequest,
	type UsageHostResponse,
} from "@ling/core/usage/usage-host-protocol";
import { type HostWorkerProcess, spawnHostWorkerProcess } from "../host-worker-process";
import { createWorkerRpc, postWorkerMessage } from "../worker-rpc";

const log = createLogger("usage-host-client");
/** Release a warm worker after two minutes without requests. */
const USAGE_HOST_IDLE_SHUTDOWN_MS = 2 * 60_000;
/** A scan must settle within two minutes or retire its worker. */
const USAGE_HOST_REQUEST_TIMEOUT_MS = 2 * 60_000;
/** Eight concurrent callers bound pending snapshots and deadline timers. */
const USAGE_HOST_REQUEST_CAPACITY = 8;

type UsageRpc = ReturnType<typeof createWorkerRpc<UsageHostRequest, UsageHostResponse, never>>;
interface UsageWorker {
	worker: HostWorkerProcess;
	rpc: UsageRpc;
}

interface UsageHostClient {
	getStats(rangeDays: UsageRangeDays, agentDir: string): Promise<UsageStatsSnapshot>;
	dispose(): Promise<void>;
}

export function createUsageHostClient(): UsageHostClient {
	let active: UsageWorker | null = null;
	let idleTimer: NodeJS.Timeout | null = null;
	let disposing = false;
	let disposal: Promise<void> | null = null;
	const retiringHosts = new Map<UsageWorker, Promise<void>>();

	const clearIdleTimer = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	};
	const retireHost = (host: UsageWorker, reason: string): Promise<void> => {
		const existing = retiringHosts.get(host);
		if (existing) return existing;
		const tracked = host.worker
			.terminate()
			.catch((error: unknown) => {
				log.error(`failed to terminate usage host (${reason}):`, error);
				throw error;
			})
			.finally(() => retiringHosts.delete(host));
		retiringHosts.set(host, tracked);
		return tracked;
	};
	const detachHost = (host: UsageWorker, error: Error, reason: string): void => {
		if (active === host) {
			active = null;
			clearIdleTimer();
		}
		host.rpc.close(error);
		// Retirement owns logging; dispose also awaits every still-retiring process.
		void retireHost(host, reason).catch(() => undefined);
	};
	const armIdleShutdown = (host: UsageWorker): void => {
		if (disposing || active !== host || host.rpc.size > 0) return;
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (disposing || active !== host || host.rpc.size > 0) return;
			detachHost(host, new Error("Usage host is idle."), "idle shutdown");
		}, USAGE_HOST_IDLE_SHUTDOWN_MS);
		idleTimer.unref();
	};
	const ensureHost = (): UsageWorker => {
		if (active) return active;
		if (disposing) throw new Error("Usage host is shutting down.");
		const worker = spawnHostWorkerProcess({
			entry: "usage-host-entry.js",
			label: "usage",
			env: sanitizeChildProcessEnvironment(),
		});
		const { child } = worker;
		const rpc = createWorkerRpc<UsageHostRequest, UsageHostResponse, never>({
			capacity: USAGE_HOST_REQUEST_CAPACITY,
			capacityError: () =>
				requestCapacityExceeded(
					"usageHostRequest",
					USAGE_HOST_REQUEST_CAPACITY,
					"The usage statistics request backlog is full. Wait for an active scan to finish, then retry.",
				),
			maxFrameBytes: USAGE_HOST_RESPONSE_MAX_BYTES,
			post: (value) => postWorkerMessage(child, value),
			onMessage(listener) {
				child.on("message", listener);
				return () => {
					child.off("message", listener);
				};
			},
			parseResponse: parseUsageHostResponse,
			onError(error) {
				log.error("usage host emitted an invalid response:", error);
				detachHost(host, error, "invalid response");
			},
		});
		const host = { worker, rpc };
		active = host;
		child.on("error", (error) => detachHost(host, error, "process error"));
		child.once("exit", (code) => {
			if (active === host) {
				active = null;
				clearIdleTimer();
				if (!disposing) log.error(`usage host exited unexpectedly with code ${code}`);
			}
			rpc.close(new Error(`Usage host exited with code ${code}.`));
		});
		return host;
	};
	return {
		async getStats(rangeDays, agentDir) {
			const host = ensureHost();
			clearIdleTimer();
			const deadlineAt = Date.now() + USAGE_HOST_REQUEST_TIMEOUT_MS;
			const request = parseUsageHostRequest({
				kind: "request",
				protocolVersion: USAGE_HOST_PROTOCOL_VERSION,
				method: "getStats",
				rangeDays,
				agentDir,
				deadlineAt,
			});
			try {
				const response = await host.rpc
					.call(request, {
						context: undefined,
						deadline: { at: deadlineAt, error: () => new Error("Usage statistics scanning timed out.") },
						onExpired() {
							detachHost(host, new Error("Usage host was terminated after a request timeout."), "request timeout");
						},
					})
					.catch((error: unknown) => {
						if (!isLingError(error) || error.code !== "REQUEST_CAPACITY_EXCEEDED")
							detachHost(host, toError(error), "request failure");
						throw error;
					});
				if (response.kind === "error")
					throw Object.assign(new Error(response.error.message), {
						code: response.error.code,
						retryable: response.error.retryable,
					});
				return response.result;
			} finally {
				armIdleShutdown(host);
			}
		},
		dispose() {
			if (disposal) return disposal;
			disposing = true;
			clearIdleTimer();
			if (active) detachHost(active, new Error("Usage host is shutting down."), "application shutdown");
			disposal = Promise.allSettled([...retiringHosts.values()]).then((results) => {
				const errors = results.flatMap((r) => (r.status === "rejected" ? [toError(r.reason)] : []));
				if (errors.length > 0) throw new AggregateError(errors, "Failed to terminate the usage host");
			});
			return disposal;
		},
	};
}
