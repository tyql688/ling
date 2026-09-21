import { attemptCleanup, throwAggregateFailures, toError } from "@ling/core/ling-error";
import {
	parseUsageHostRequest,
	parseUsageHostResponse,
	USAGE_HOST_RESPONSE_MAX_BYTES,
	type UsageHostResponse,
} from "@ling/core/usage/usage-host-protocol";
import { createUsageHostService } from "@ling/host/workers/usage/usage-host-service";
import { createWorkerRpc, postWorkerMessage } from "../worker-rpc";

if (!process.send) throw new Error("usage-host-entry requires a Node IPC channel");

const service = createUsageHostService();
let rpc: { close(error: Error): void } | null = null;
let shutdown: Promise<void> | null = null;

function stop(startupError?: Error): void {
	if (shutdown !== null) return;
	const failures: unknown[] = startupError === undefined ? [] : [startupError];
	// Stop inbound requests before cancelling the scanner; startup failures take the same cleanup path.
	attemptCleanup(failures, () => rpc?.close(startupError ?? new Error("Usage worker stopped")));
	shutdown = service
		.dispose()
		.then(
			() => throwAggregateFailures(failures, "Usage worker shutdown failed"),
			(error: unknown) => {
				failures.push(error);
				throwAggregateFailures(failures, "Usage worker shutdown failed");
			},
		)
		.then(
			() => process.exit(0),
			(error: unknown) => {
				console.error("[usage-host] Shutdown failed:", error);
				process.exit(1);
			},
		);
	void shutdown;
}

process.once("disconnect", () => stop());
process.once("SIGTERM", () => stop());
process.once("SIGINT", () => stop());

try {
	rpc = createWorkerRpc<never, UsageHostResponse, never>({
		// This endpoint only receives calls; no outbound request may be admitted.
		capacity: 0,
		capacityError: () => new Error("Usage worker cannot initiate requests"),
		maxFrameBytes: USAGE_HOST_RESPONSE_MAX_BYTES,
		post: (value) => postWorkerMessage(process, value),
		onMessage(listener) {
			process.on("message", listener);
			return () => {
				process.off("message", listener);
			};
		},
		receiveRequest: (payload) => service.handleRequest(parseUsageHostRequest(payload)),
		parseResponse: parseUsageHostResponse,
		onError: (error) => console.error("[usage-host] RPC failure:", error),
	});
} catch (error) {
	stop(toError(error));
}
