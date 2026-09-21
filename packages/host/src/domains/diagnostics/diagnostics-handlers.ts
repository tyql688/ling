import type { DiagnosticProcess } from "@ling/contracts/diagnostics";
import { diagnosticsProcedures } from "@ling/contracts/diagnostics-procedures";
import type { DiagnosticsStore } from "../../runtime/diagnostics-store";
import type { HostDomain } from "../../transport/host-domain";

export function createDiagnosticsDomain({
	store,
	listProcesses,
}: {
	store: DiagnosticsStore | null;
	listProcesses(): DiagnosticProcess[];
}): HostDomain {
	return {
		handlers: {
			[diagnosticsProcedures.logs.channel]: async (_context, query) =>
				store ? store.query(query) : { records: [], processes: [], components: [] },
			[diagnosticsProcedures.processes.channel]: async () => listProcesses(),
		},
	};
}
