import type { ConfiguredPackage } from "@ling/contracts/plugin";
import { pluginToolRequestSchema } from "@ling/contracts/plugin-validation";
import { createBuiltinOperationRef } from "@ling/contracts/owner-ref";
import {
	PLUGIN_MUTATION_DEADLINE_MS,
	PLUGIN_MUTATION_OWNER_ID,
	pluginMutationRevision,
} from "@ling/contracts/plugin-operation";
import { createLingError } from "@ling/core/ling-error";
import { parsePiWorkerSessionRef } from "@ling/core/pi-protocol/protocol-validation";
import { normalizePluginSource } from "@ling/core/plugin-host/source";
import type { SessionRef } from "@ling/contracts/session";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import type { PluginClient } from "@ling/host/workers/plugin/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginMutationRunner } from "./plugin-mutation";
import { installPluginRequestSchema, removePluginRequestSchema, updatePluginRequestSchema } from "./plugin-schemas";

/** Keep package listings bounded in the model context; source/scope filters narrow larger inventories. */
const TOOL_PACKAGE_LIMIT = 100;

function packageInventory(packages: ConfiguredPackage[]) {
	return {
		packages: packages.slice(0, TOOL_PACKAGE_LIMIT).map(({ source, scope, installedPath, resolution, counts }) => ({
			source,
			scope,
			installedPath,
			resolution,
			counts,
		})),
		total: packages.length,
		omitted: Math.max(0, packages.length - TOOL_PACKAGE_LIMIT),
	};
}

export function createPluginTool(options: {
	client: PluginClient;
	mutations: PluginMutationRunner;
	projects: ProjectAccess;
	requireManagedSession(ref: SessionRef): unknown;
}) {
	const { checkPluginUpdates, installPlugin, removePlugin, resolveConfiguredPlugins, updatePlugins } = options.client;
	const { runPluginMutation } = options.mutations;
	const { withKnownOpenProject } = options.projects;
	const { requireManagedSession } = options;

	/** The session supplies its own project; model arguments cannot select another workspace. */
	async function runPluginTool(value: unknown, signal: AbortSignal): Promise<string> {
		const params = z.strictObject({ ref: z.unknown(), request: pluginToolRequestSchema }).parse(value);
		const ref = parsePiWorkerSessionRef(params.ref);
		requireManagedSession(ref);
		signal.throwIfAborted();
		const request = params.request;
		const source = request.source == null ? request.source : normalizePluginSource(request.source);
		const packages = await withKnownOpenProject(ref.cwd, (cwd) => resolveConfiguredPlugins(cwd, signal));
		const selected = packages.filter(
			(pkg) =>
				(request.scope === undefined || request.scope === "all" || pkg.scope === request.scope) &&
				(source == null || pkg.source === source || pkg.installedPath === source),
		);
		if (request.action === "list") {
			return JSON.stringify({ action: request.action, ...packageInventory(selected) });
		}
		if (request.action === "check_updates") {
			const updates = (await withKnownOpenProject(ref.cwd, (cwd) => checkPluginUpdates(cwd, signal))).filter((update) =>
				selected.some((pkg) => pkg.source === update.source && pkg.scope === update.scope),
			);
			return JSON.stringify({
				action: request.action,
				coverage: "positiveMatchesOnly",
				updates: updates.slice(0, TOOL_PACKAGE_LIMIT),
				total: updates.length,
				omitted: Math.max(0, updates.length - TOOL_PACKAGE_LIMIT),
			});
		}
		if (request.action !== "install" && source !== null && selected.length === 0) {
			throw createLingError({
				code: "INVALID_REQUEST",
				category: "validation",
				retryable: false,
				message: "The package is not configured in the requested scope. List installed packages before retrying.",
			});
		}
		// Pi persists local sources relative to their settings file. Scoped mutations use
		// that exact configured entry; the package worker resolves its mutation identity.
		const configured = selected[0];
		const mutationSource =
			request.action === "install"
				? normalizePluginSource(request.source)
				: request.source === null
					? null
					: request.scope === "all"
						? normalizePluginSource(request.source)
						: configured?.source;
		if (mutationSource === undefined) throw new Error("Configured plugin mutation target is missing");
		const target = {
			cwd: ref.cwd,
			source: mutationSource,
			scope: request.scope,
			deadlineAt: Date.now() + PLUGIN_MUTATION_DEADLINE_MS,
			operation: createBuiltinOperationRef(randomUUID(), PLUGIN_MUTATION_OWNER_ID, {
				scope: { kind: "project", ref: { cwd: ref.cwd } },
				revision: pluginMutationRevision(request.action, mutationSource, ref.cwd, request.scope),
				generation: 0,
			}),
		};
		let result: Awaited<ReturnType<typeof runPluginMutation>>;
		switch (request.action) {
			case "install":
				result = await runPluginMutation(
					"install",
					installPluginRequestSchema.parse(target),
					(request, cwd, signal) =>
						installPlugin(
							{ cwd, source: request.source, scope: request.scope, deadlineAt: request.deadlineAt },
							signal,
						),
					signal,
				);
				break;
			case "remove":
				result = await runPluginMutation(
					"remove",
					removePluginRequestSchema.parse(target),
					(request, cwd, signal) =>
						removePlugin({ cwd, source: request.source, scope: request.scope, deadlineAt: request.deadlineAt }, signal),
					signal,
				);
				break;
			case "update":
				result = await runPluginMutation(
					"update",
					updatePluginRequestSchema.parse(target),
					(request, cwd, signal, projectTrusted) =>
						updatePlugins(
							{ cwd, source: request.source, scope: request.scope, deadlineAt: request.deadlineAt, projectTrusted },
							signal,
						),
					signal,
				);
				break;
		}
		const inventory = await withKnownOpenProject(ref.cwd, (cwd) => resolveConfiguredPlugins(cwd, signal));
		return JSON.stringify({
			action: request.action,
			source: mutationSource,
			scope: request.scope,
			outcome: "completed",
			mutation: result.mutation,
			reload: result.reload,
			// Updates can affect the same identity in another scope; retain both scopes in the inventory.
			...packageInventory(inventory),
		});
	}
	return { runPluginTool };
}
