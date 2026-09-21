import { usageProcedures } from "@ling/contracts/usage-procedures";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import { createUsageHostClient } from "@ling/host/workers/usage/usage-host-client";
import { resolve } from "node:path";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";

export function createUsageDomain({ piWorker }: { piWorker: PiWorkerClient }): HostDomain {
	const usageHost = createUsageHostClient();
	const handlers: HostHandlers = {
		[usageProcedures.getStats.channel]: async (_context, value) => {
			const { agentDir } = await piWorker.getAgentInfo();
			return usageHost.getStats(value, resolve(agentDir));
		},

		[usageProcedures.getProviderQuotas.channel]: async (context) => piWorker.getProviderQuotas(context.signal),
	};
	return { handlers, dispose: () => usageHost.dispose() };
}
