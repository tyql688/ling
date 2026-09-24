import type { McpWriteRequest } from "@ling/contracts/mcp";
import { requestCancelled, requestCapacityExceeded } from "@ling/core/ling-error";
import type { PiWorkerClient } from "../../../workers/pi/pi-worker-client";
import { piResourceReloadError, type ResourceReloadCoordinator } from "../../resources/resource-reload";

/** Configuration stays editable while MCP is off; every writer shares admission and reconciliation. */
export function createMcpSettings(options: {
	piWorker: Pick<PiWorkerClient, "readMcp" | "writeMcp">;
	resources: Pick<ResourceReloadCoordinator, "mutateThenReloadPiResources" | "onPiResourcesReloaded">;
	assertProject(cwd: string): Promise<void>;
	onChanged(): void;
}) {
	let stopping = false;
	let active: Promise<unknown> | null = null;
	const unsubscribeReload = options.resources.onPiResourcesReloaded(options.onChanged);
	async function admit(cwd: string | null) {
		if (stopping) throw requestCancelled("MCP settings are shutting down");
		if (cwd !== null) await options.assertProject(cwd);
		if (stopping) throw requestCancelled("MCP settings are shutting down");
	}
	return {
		async read(cwd: string | null, signal: AbortSignal) {
			await admit(cwd);
			return options.piWorker.readMcp(cwd, signal);
		},
		write(input: McpWriteRequest, signal: AbortSignal) {
			if (active) throw requestCapacityExceeded("mcp", 1, "Another MCP configuration change is in progress");
			const task = (async () => {
				await admit(input.cwd);
				const result = await options.resources.mutateThenReloadPiResources(
					"MCP configuration and reload failed",
					async () => {
						const result = await options.piWorker.writeMcp(input, signal);
						// Server definitions are consumed by session_start, not the project catalog.
						if (result.changed) options.onChanged();
						return result.reloadProjects ?? undefined;
					},
					{ mode: "configuration", reloadProjectCatalogs: false },
				);
				if (result.mutation.failed) {
					const failure = piResourceReloadError(result.reload);
					if (failure) throw new AggregateError([result.mutation.error, failure], "MCP configuration failed");
					throw result.mutation.error;
				}
				return result.reload;
			})().finally(() => {
				active = null;
			});
			active = task;
			return task;
		},
		prepareShutdown() {
			stopping = true;
		},
		async dispose() {
			stopping = true;
			await Promise.allSettled(active ? [active] : []);
			unsubscribeReload();
		},
	};
}
export type McpSettings = ReturnType<typeof createMcpSettings>;
