import { usageProcedures } from "@ling/contracts/usage-procedures";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import { createUsageHostClient } from "@ling/host/workers/usage/usage-host-client";
import { dirname } from "node:path";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";

export function createUsageDomain({
	piWorker,
	retainedSessionFiles,
}: {
	piWorker: PiWorkerClient;
	retainedSessionFiles(): Promise<string[]>;
}): HostDomain {
	const usageHost = createUsageHostClient();
	const handlers: HostHandlers = {
		[usageProcedures.getStats.channel]: async (_context, value) => {
			const [directories, retained] = await Promise.all([
				piWorker.getSessionStorageDirectories(),
				retainedSessionFiles(),
			]);
			return usageHost.getStats(value, [...new Set([...directories, ...retained.map((path) => dirname(path))])]);
		},

		[usageProcedures.getProviderQuotas.channel]: async (context) => piWorker.getProviderQuotas(context.signal),
	};
	return { handlers, dispose: () => usageHost.dispose() };
}
