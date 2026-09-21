import { throwAggregateFailures } from "@ling/core/ling-error";
import type { PiWorkerParentMessage } from "@ling/core/pi-protocol/protocol";
import { PI_WORKER_PROTOCOL_VERSION } from "@ling/core/pi-protocol/wire-format";
import type { HostWorkerProcess } from "../host-worker-process";
import type { PiWorkerControlPort } from "@ling/host/workers/pi/pi-worker-node-control";
import type { ChildProcess } from "node:child_process";

const SHUTDOWN_TIMEOUT_MS = 5_000;

interface PiWorkerShutdownTarget {
	generation: number;
	worker: HostWorkerProcess;
	child: ChildProcess;
	port: PiWorkerControlPort;
	exitPromise: Promise<number>;
	shutdownComplete: Promise<void>;
	shutdownAcknowledged: boolean;
	exited: boolean;
}

export async function shutdownPiWorkerGeneration(host: PiWorkerShutdownTarget): Promise<void> {
	const failures: unknown[] = [];
	try {
		host.port.postMessage({
			kind: "shutdown",
			protocolVersion: PI_WORKER_PROTOCOL_VERSION,
			generation: host.generation,
		});
	} catch (error) {
		failures.push(error);
	}
	try {
		if (!host.child.connected) throw new Error("Pi worker process IPC is disconnected");
		host.child.send({
			kind: "shutdown",
			protocolVersion: PI_WORKER_PROTOCOL_VERSION,
			generation: host.generation,
		} satisfies PiWorkerParentMessage);
	} catch (error) {
		failures.push(error);
	}

	let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	try {
		if (failures.length > 0) {
			await host.worker.terminate();
		} else {
			const timeout = new Promise<"timeout">((resolve) => {
				timeoutTimer = setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
				timeoutTimer.unref();
			});
			const completion = await Promise.race([
				Promise.all([host.shutdownComplete, host.exitPromise]).then(([, exitCode]) => ({
					kind: "complete" as const,
					exitCode,
				})),
				timeout.then(() => ({ kind: "timeout" as const })),
			]);
			if (completion.kind === "timeout") {
				if (host.exited) failures.push(new Error("Pi worker exited before acknowledging shutdown"));
				else await host.worker.terminate();
			} else if (completion.exitCode !== 0) {
				failures.push(new Error(`Pi worker exited with code ${completion.exitCode} during shutdown`));
			}
		}
	} catch (error) {
		failures.push(error);
	} finally {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		try {
			host.port.close();
		} catch (error) {
			failures.push(error);
		}
	}

	throwAggregateFailures(failures, "Failed to shut down the Pi worker cleanly");
}
