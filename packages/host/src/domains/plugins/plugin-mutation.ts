import type { PluginMutationOperationRequest } from "@ling/contracts/plugin";
import type { PluginMutationAction } from "@ling/contracts/plugin-operation";
import { createLingError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { PluginMutationHostResult } from "@ling/core/plugin-host/protocol";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import {
	piResourceReloadError,
	piResourceReloadFailed,
	type ResourceReloadCoordinator,
} from "@ling/host/domains/resources/resource-reload";
import type { PluginOperationRegistry } from "./operations";

const log = createLogger("plugin-mutation");

export function createPluginMutationRunner({
	projectPiConfig,
	withKnownOpenProject,
	reloadPiResources,
	pluginOperations,
}: {
	projectPiConfig: PiWorkerClient["projectPiConfig"];
	withKnownOpenProject: ProjectAccess["withKnownOpenProject"];
	reloadPiResources: ResourceReloadCoordinator["reloadPiResources"];
	pluginOperations: PluginOperationRegistry;
}) {
	const pendingMutations = new Set<Promise<void>>();
	/** Track one mutation and reconcile even partial writes, independently of its UI or agent caller. */
	async function runPluginMutation<
		Request extends PluginMutationOperationRequest & {
			source: string | null;
			scope: "global" | "project" | "all";
		},
	>(
		kind: PluginMutationAction,
		request: Request,
		run: (
			request: Request,
			cwd: string,
			signal: AbortSignal,
			projectTrusted: boolean,
		) => Promise<PluginMutationHostResult>,
		signal?: AbortSignal,
	) {
		signal?.throwIfAborted();
		const operation = pluginOperations.start(kind, request);
		const cancel = () => {
			pluginOperations.cancel({ operation: request.operation });
		};
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const work = operation.run(async (signal) => {
				const outcome = await withKnownOpenProject(request.cwd, async (cwd) => {
					// The separate package worker does not own the live project's trust decision.
					const { trusted } = await projectPiConfig(cwd);
					if (request.scope !== "global" && !trusted) {
						throw createLingError({
							code: "PACKAGE_OPERATION_FAILED",
							category: "validation",
							message: "Project is not trusted. Trust the project in Ling before modifying project packages.",
							retryable: false,
						});
					}
					try {
						return { status: "completed", mutation: await run(request, cwd, signal, trusted) } as const;
					} catch (error) {
						return { status: "failed", error } as const;
					}
				});
				let reload: Awaited<ReturnType<typeof reloadPiResources>>;
				try {
					reload = await reloadPiResources();
				} catch (reloadError) {
					if (outcome.status === "failed") {
						throw new AggregateError(
							[outcome.error, reloadError],
							`Plugin ${kind} and Pi resource reconciliation both failed`,
						);
					}
					throw reloadError;
				}
				if (piResourceReloadFailed(reload)) {
					log.error(`Plugin ${kind} resource reconciliation was incomplete:`, reload);
				}
				if (outcome.status === "failed") {
					const reloadError = piResourceReloadError(
						reload,
						`Plugin ${kind} failed, and one or more live Pi resources could not reload.`,
					);
					if (reloadError) {
						throw new AggregateError(
							[outcome.error, reloadError],
							`Plugin ${kind} and Pi resource reconciliation both failed`,
						);
					}
					throw outcome.error;
				}
				return { requestId: request.operation.requestId, reload, mutation: outcome.mutation };
			});
			const settlement = work.then(
				() => undefined,
				() => undefined,
			);
			pendingMutations.add(settlement);
			void settlement.then(() => pendingMutations.delete(settlement));
			return await work;
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	}
	return {
		runPluginMutation,
		async dispose() {
			pluginOperations.dispose();
			// The request promise owns mutation failures; shutdown drains their reconciliation.
			await Promise.all([...pendingMutations]);
		},
	};
}

export type PluginMutationRunner = ReturnType<typeof createPluginMutationRunner>;
