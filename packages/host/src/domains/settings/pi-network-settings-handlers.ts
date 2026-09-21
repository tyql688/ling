import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import { networkProcedures } from "@ling/contracts/network-procedures";
import { piSettingsProcedures } from "@ling/contracts/pi-settings-procedures";
import { piResourceReloadError, type ResourceReloadCoordinator } from "@ling/host/domains/resources/resource-reload";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";

/** The only settings mutation that changes loaded resources: skill commands are part
 * of every session's command catalog, so live generations must actually rebuild. */
function isResourceAffectingSettingsUpdate(update: { type: string }): boolean {
	return update.type === "enableSkillCommands";
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
	 * (delivery modes, compaction/retry, shell paths) or consumed only when a new session
	 * is constructed (default model/thinking). Refreshing those instances in place reaches
	 * every live session without the full project/session generation rebuild, which costs
	 * seconds per open project and made each settings toggle visibly slow. */
	async function mutateAndRefreshPiSettings(mutate: () => Promise<void>): Promise<void> {
		await mutate();
		await piWorker.refreshSettingsSnapshots();
	}

	const handlers: HostHandlers = {
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
