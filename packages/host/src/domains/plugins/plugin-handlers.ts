import type { InstallPluginRequest, RemovePluginRequest, UpdatePluginRequest } from "@ling/contracts/plugin";
import { pluginsProcedures } from "@ling/contracts/plugin-procedures";
import type { OperationRef } from "@ling/contracts/owner-ref";
import { throwAggregateFailures } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { PluginMutationHostResult } from "@ling/core/plugin-host/protocol";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import { piResourceReloadFailed, type ResourceReloadCoordinator } from "@ling/host/domains/resources/resource-reload";
import type { PluginClient } from "@ling/host/workers/plugin/client";
import type { PluginHostClientTransport } from "@ling/host/workers/plugin/client-transport";
import type { HostEventPublisher } from "../../transport/event-bus";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import type { HostRequestContext } from "../../transport/request-router";
import type { PluginOperationRegistry } from "./operations";
import type { PluginMutationRunner } from "./plugin-mutation";

const log = createLogger("plugin-ipc");

export function createPluginDomain(options: {
	client: PluginClient;
	mutations: PluginMutationRunner;
	operations: PluginOperationRegistry;
	transport: PluginHostClientTransport;
	resources: ResourceReloadCoordinator;
	projects: ProjectAccess;
	events: HostEventPublisher;
}): HostDomain {
	const { checkPluginUpdates, installPlugin, removePlugin, resolveConfiguredPlugins, updatePlugins } = options.client;
	const { runPluginMutation } = options.mutations;
	const pluginOperations = options.operations;
	const { onLatePluginMutationSettlement } = options.transport;
	const { reloadPiResources } = options.resources;
	const { withKnownOpenProject } = options.projects;

	/** Runs a plugin mutation as a cancellable tracked operation, then reconciles every
	 * project catalog and live session before the IPC resolves. Reconciliation also runs
	 * after failure because an admitted package operation may already have touched disk. */
	const mutation = <
		Request extends {
			cwd: string;
			operation: OperationRef;
			deadlineAt: number;
			source: string | null;
			scope: "global" | "project" | "all";
		},
	>(
		kind: "install" | "remove" | "update",
		run: (
			request: Request,
			cwd: string,
			signal: AbortSignal,
			projectTrusted: boolean,
		) => Promise<PluginMutationHostResult>,
	) =>
		async function handleMutation(_event: HostRequestContext, request: Request) {
			const { requestId, reload } = await runPluginMutation(kind, request, run);
			return { requestId, reload };
		};
	const handlers: HostHandlers = {
		[pluginsProcedures.list.channel]: async (_event, value) => {
			return withKnownOpenProject(value.cwd, resolveConfiguredPlugins);
		},

		[pluginsProcedures.checkUpdates.channel]: async (_event, value) => {
			return withKnownOpenProject(value.cwd, checkPluginUpdates);
		},

		[pluginsProcedures.install.channel]: mutation<InstallPluginRequest>("install", (request, cwd, signal) =>
			installPlugin({ cwd, source: request.source, scope: request.scope, deadlineAt: request.deadlineAt }, signal),
		),

		[pluginsProcedures.remove.channel]: mutation<RemovePluginRequest>("remove", (request, cwd, signal) =>
			removePlugin({ cwd, source: request.source, scope: request.scope, deadlineAt: request.deadlineAt }, signal),
		),

		[pluginsProcedures.update.channel]: mutation<UpdatePluginRequest>(
			"update",
			(request, cwd, signal, projectTrusted) =>
				updatePlugins(
					{ cwd, source: request.source, scope: request.scope, deadlineAt: request.deadlineAt, projectTrusted },
					signal,
				),
		),

		[pluginsProcedures.cancelOperation.channel]: async (_event, value) =>
			(async () => pluginOperations.cancel(value))(),
	};
	const unsubscribeSettlement = onLatePluginMutationSettlement((settlement) => {
		void reloadPiResources()
			.then((reload) => {
				if (piResourceReloadFailed(reload)) {
					log.error(
						`Late plugin ${settlement.method} ${settlement.outcome}; Pi resource reconciliation was incomplete:`,
						reload,
					);
				}
			})
			.catch((error: unknown) => {
				log.error(`Late plugin ${settlement.method} ${settlement.outcome}; Pi resource reconciliation failed:`, error);
			});
	});
	const unsubscribeProgress = options.transport.onPackageManagerProgress((progress) => {
		options.events.broadcast(pluginsProcedures.onProgress.channel, progress);
	});
	return {
		handlers,
		dispose() {
			const failures: unknown[] = [];
			for (const unsubscribe of [unsubscribeProgress, unsubscribeSettlement]) {
				try {
					unsubscribe();
				} catch (error) {
					failures.push(error);
				}
			}
			throwAggregateFailures(failures, "Failed to release plugin subscriptions");
		},
	};
}
