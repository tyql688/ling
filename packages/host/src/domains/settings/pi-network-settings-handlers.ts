import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import { networkProcedures } from "@ling/contracts/network-procedures";
import { piSettingsProcedures } from "@ling/contracts/pi-settings-procedures";
import { piResourceReloadError, type ResourceReloadCoordinator } from "@ling/host/domains/resources/resource-reload";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import { PI_TERMINAL_CONFIGURATION_KEYS } from "@ling/contracts/pi-configuration";
import { isDeepStrictEqual } from "node:util";

/** Command catalogs and active tool sets belong to each session's resource generation. */
function isResourceAffectingSettingsUpdate(update: { type: string }): boolean {
	return ["enableSkillCommands", "defaultTools", "shellPath", "shellCommandPrefix", "imageAutoResize"].includes(
		update.type,
	);
}

export function createPiSettingsDomain({
	piWorker,
	resources,
	events,
}: {
	piWorker: PiWorkerClient;
	resources: ResourceReloadCoordinator;
	events: HostEventPublisher;
}): HostDomain {
	const { mutateThenReloadPiResources } = resources;

	async function mutateAndReloadPiSettings(mutate: () => Promise<void>): Promise<void> {
		const bothFailedMessage = "The Pi setting mutation and Pi resource reconciliation both failed";
		const { mutation, reload } = await mutateThenReloadPiResources(bothFailedMessage, mutate);
		const outcome = mutation.failed ? "The Pi setting mutation failed" : "The Pi setting was saved";
		const reloadError = piResourceReloadError(
			reload,
			`${outcome}, but one or more live Pi resources could not reload.`,
		);
		if (mutation.failed && reloadError) throw new AggregateError([mutation.error, reloadError], bothFailedMessage);
		if (mutation.failed) throw mutation.error;
		if (reloadError) throw reloadError;
	}

	/** Value-only settings are read lazily through the shared SettingsManager instances
	 * (delivery modes, compaction/retry) or consumed only when a new session
	 * is constructed (default model/thinking). Refreshing those instances in place reaches
	 * every live session without the full project/session generation rebuild, which costs
	 * seconds per open project and made each settings toggle visibly slow. */
	async function mutateAndRefreshPiSettings(mutate: () => Promise<void>): Promise<void> {
		await mutate();
		await piWorker.refreshSettingsSnapshots();
	}

	const handlers: HostHandlers = {
		[piSettingsProcedures.configuration.channel]: async (_event, request) => {
			if (request.cwd !== null) piWorker.resolveProject(request.cwd);
			return piWorker.readConfiguration(request);
		},
		[piSettingsProcedures.writeConfiguration.channel]: async (_event, request) => {
			if (request.cwd !== null) piWorker.resolveProject(request.cwd);
			const before = await piWorker.readConfiguration({ cwd: request.cwd });
			const valueOnly = new Set<string>([
				...PI_TERMINAL_CONFIGURATION_KEYS,
				"defaultModel",
				"defaultProvider",
				"defaultThinkingLevel",
				"modelThinkingLevels",
				"thinkingBudgets",
				"transport",
				"steeringMode",
				"followUpMode",
				"compaction",
				"branchSummary",
				"retry",
				"httpIdleTimeoutMs",
				"websocketConnectTimeoutMs",
				"cacheWarming",
				"sessionDir",
				"httpProxy",
				"npmCommand",
				"enableAnalytics",
				"enableInstallTelemetry",
				"defaultProjectTrust",
			]);
			const changed = [...new Set([...Object.keys(before.configured), ...Object.keys(request.settings)])].filter(
				(key) => !isDeepStrictEqual(before.configured[key], request.settings[key]),
			);
			let reload = null;
			try {
				if (changed.some((key) => !valueOnly.has(key))) {
					const outcome = await mutateThenReloadPiResources(
						"Pi configuration could not be saved and applied",
						async () => {
							await piWorker.writeConfiguration(request);
							return request.cwd === null ? undefined : [request.cwd];
						},
					);
					if (outcome.mutation.failed) {
						const failure = piResourceReloadError(outcome.reload);
						if (failure)
							throw new AggregateError(
								[outcome.mutation.error, failure],
								"Pi configuration could not be saved and applied",
							);
						throw outcome.mutation.error;
					}
					reload = outcome.reload;
				} else {
					await mutateAndRefreshPiSettings(() => piWorker.writeConfiguration(request));
				}
				return { configuration: await piWorker.readConfiguration({ cwd: request.cwd }), reload };
			} finally {
				events.broadcast(piSettingsProcedures.onChanged.channel, null);
			}
		},
		[networkProcedures.getProxy.channel]: async () => piWorker.getProxy(),

		[networkProcedures.setProxy.channel]: async (_event, value) => {
			// The proxy applies process-wide through the Pi worker dispatcher inside the setter.
			await mutateAndRefreshPiSettings(() => piWorker.setProxy(value));
		},

		[piSettingsProcedures.get.channel]: async () => piWorker.getSettings(),

		[piSettingsProcedures.getRecoveryStatus.channel]: async () => piWorker.getSettingsRecoveryStatus(),

		[piSettingsProcedures.repairHttpIdleTimeout.channel]: async () => {
			// The repaired timeout reconfigures the Pi worker dispatcher inside the repair itself.
			try {
				await mutateAndRefreshPiSettings(() => piWorker.repairHttpIdleTimeout());
				return await piWorker.getSettings();
			} finally {
				events.broadcast(piSettingsProcedures.onChanged.channel, null);
			}
		},

		[piSettingsProcedures.update.channel]: async (_event, value) => {
			try {
				if (isResourceAffectingSettingsUpdate(value)) {
					await mutateAndReloadPiSettings(() => piWorker.updateSettings(value));
				} else {
					await mutateAndRefreshPiSettings(() => piWorker.updateSettings(value));
				}
				return await piWorker.getSettings();
			} finally {
				events.broadcast(piSettingsProcedures.onChanged.channel, null);
			}
		},
	};
	return { handlers };
}
