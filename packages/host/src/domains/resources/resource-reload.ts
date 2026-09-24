import {
	type PiResourceReloadSummary,
	type PiResourceReloadMode,
	mergePiResourceReloadModes,
	SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS,
	type SessionResourceReloadSummary,
} from "@ling/contracts/session";
import { errorMessage } from "@ling/contracts/ling-error";
import { requestCancelled, throwAggregateFailures } from "@ling/core/ling-error";

function boundedErrorMessage(error: unknown): string {
	const message = errorMessage(error);
	if (message.length <= SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS) return message;
	const boundary = message.charCodeAt(SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS - 1);
	const endsWithHighSurrogate = boundary >= 0xd800 && boundary <= 0xdbff;
	return message.slice(
		0,
		endsWithHighSurrogate ? SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS - 1 : SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS,
	);
}

export function piResourceReloadFailed(summary: PiResourceReloadSummary): boolean {
	return (
		summary.projectError !== null ||
		summary.sessionError !== null ||
		(summary.sessions?.failed.length ?? 0) > 0 ||
		(summary.sessions?.failedOmitted ?? 0) > 0
	);
}

export function piResourceReloadError(
	summary: PiResourceReloadSummary,
	message = "One or more live Pi resources could not reload.",
): (Error & { code: "PI_RESOURCE_RELOAD_INCOMPLETE"; summary: PiResourceReloadSummary }) | null {
	if (!piResourceReloadFailed(summary)) return null;
	return Object.assign(new Error(message), {
		code: "PI_RESOURCE_RELOAD_INCOMPLETE" as const,
		summary,
	});
}

interface ResourceReloadOptions {
	mode?: PiResourceReloadMode;
	/** Host-only switches and adapter configuration do not change the project catalog. */
	reloadProjectCatalogs?: boolean;
}

type PiMutationOutcome = { failed: false } | { failed: true; error: unknown };

export function createResourceReloadCoordinator({
	reloadProjectSettings,
	reloadSessionResources,
}: {
	reloadProjectSettings(projectCwds?: readonly string[], mode?: PiResourceReloadMode): Promise<void>;
	reloadSessionResources(
		projectCwds?: readonly string[],
		mode?: PiResourceReloadMode,
	): Promise<SessionResourceReloadSummary>;
}) {
	let stopping = false;
	let disposal: Promise<void> | null = null;

	let activeReload: Promise<PiResourceReloadSummary> | null = null;
	let queuedReload: Promise<PiResourceReloadSummary> | null = null;
	// null means all projects; a queued pass accumulates every admitted mutation's targets.
	let queuedProjects: Set<string> | null = new Set();
	let queuedMode: PiResourceReloadMode = "adapters";
	let queuedProjectCatalogs = false;
	const reloadListeners = new Set<() => void>();
	const pendingMutations = new Set<Promise<{ mutation: PiMutationOutcome; reload: PiResourceReloadSummary }>>();

	/** Runs after every reload pass settles (success or not — project diagnostics may have changed
	 * either way). Used to tell the renderer its cached project catalog is stale. */
	function onPiResourcesReloaded(listener: () => void): () => void {
		reloadListeners.add(listener);
		return () => void reloadListeners.delete(listener);
	}

	/** Reconcile one coherent project-catalog → live-session generation. Each half is
	 * best-effort: one failure never prevents the other from reconciling. */
	async function reloadPiResourcesNow(
		projectCwds?: readonly string[],
		options: ResourceReloadOptions = {},
	): Promise<PiResourceReloadSummary> {
		let projectError: string | null = null;
		const projectReloads = await Promise.allSettled(
			projectCwds?.length === 0 || options.reloadProjectCatalogs === false
				? []
				: [options.mode ? reloadProjectSettings(projectCwds, options.mode) : reloadProjectSettings(projectCwds)],
		);
		const projectFailures = projectReloads.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (projectFailures.length === 1) {
			projectError = boundedErrorMessage(projectFailures[0]);
		} else if (projectFailures.length > 1) {
			projectError = boundedErrorMessage(
				new AggregateError(projectFailures, "Pi worker project settings reload failed"),
			);
		}

		try {
			return {
				projectError,
				sessions: await (options.mode
					? reloadSessionResources(projectCwds, options.mode)
					: reloadSessionResources(projectCwds)),
				sessionError: null,
			};
		} catch (error) {
			return {
				projectError,
				sessions: null,
				sessionError: boundedErrorMessage(error),
			};
		}
	}

	/**
	 * Reconciles both Pi catalog views after a global resource mutation. The whole flow
	 * is serialized, not just each half: a later mutation cannot rebuild project catalogs
	 * between an earlier mutation's project and session phases. Calls arriving during an
	 * active pass share at most one queued follow-up, whose result includes those later
	 * mutations instead of being swallowed by the earlier pass.
	 */
	function scheduleReload(
		projectCwds?: readonly string[],
		options: ResourceReloadOptions = {},
	): Promise<PiResourceReloadSummary> {
		// A no-op mutation must not wait for, or enqueue a pass behind, an unrelated reload.
		if (projectCwds?.length === 0) return reloadPiResourcesNow([]);
		if (activeReload || queuedReload) {
			queuedMode = mergePiResourceReloadModes(queuedMode, options.mode ?? "full");
			if (options.reloadProjectCatalogs !== false) queuedProjectCatalogs = true;
			if (projectCwds === undefined) queuedProjects = null;
			else for (const cwd of projectCwds) queuedProjects?.add(cwd);
		}
		// The active pass may have settled while its queued reaction is still waiting
		// in the microtask queue. A new mutation in that narrow edge belongs to the
		// already-promised follow-up instead of starting a redundant pass first.
		if (!activeReload && queuedReload) return queuedReload;
		if (activeReload) {
			const next = () => {
				const projects = queuedProjects === null ? undefined : [...queuedProjects];
				const options: ResourceReloadOptions = { mode: queuedMode, reloadProjectCatalogs: queuedProjectCatalogs };
				queuedProjects = new Set();
				queuedMode = "adapters";
				queuedProjectCatalogs = false;
				queuedReload = null;
				return scheduleReload(projects, options);
			};
			queuedReload ??= activeReload.then(next, next);
			return queuedReload;
		}

		const tracked: Promise<PiResourceReloadSummary> = reloadPiResourcesNow(projectCwds, options).finally(() => {
			if (activeReload === tracked) activeReload = null;
			if (projectCwds?.length !== 0 && options.reloadProjectCatalogs !== false && options.mode !== "adapters")
				for (const listener of reloadListeners) listener();
		});
		activeReload = tracked;
		return tracked;
	}

	/** Shared skeleton for "canonical mutation, then reconcile live Pi resources".
	 * Reconciliation always runs — an admitted mutation may already have touched disk.
	 * When the reconciliation pass itself rejects, an earlier mutation failure is
	 * preserved alongside it; otherwise both outcomes return so each IPC surface can
	 * apply its own policy (throw where the UI has no reload notice, return where it does). */
	async function mutateAndReload(
		bothFailedMessage: string,
		// A successful mutation may return exactly the projects whose effective resources changed.
		mutate: () => Promise<void | readonly string[]>,
		options: ResourceReloadOptions = {},
	): Promise<{ mutation: PiMutationOutcome; reload: PiResourceReloadSummary }> {
		let mutation: PiMutationOutcome = { failed: false };
		let projectCwds: readonly string[] | undefined;
		try {
			projectCwds = (await mutate()) ?? undefined;
		} catch (error) {
			mutation = { failed: true, error };
		}
		try {
			return { mutation, reload: await scheduleReload(projectCwds, options) };
		} catch (reloadError) {
			if (mutation.failed) throw new AggregateError([mutation.error, reloadError], bothFailedMessage);
			throw reloadError;
		}
	}
	function mutateThenReloadPiResources(
		...args: Parameters<typeof mutateAndReload>
	): ReturnType<typeof mutateAndReload> {
		if (stopping) return Promise.reject(requestCancelled("Pi resource mutation admission has stopped."));
		const work = mutateAndReload(...args);
		const tracked = work.finally(() => pendingMutations.delete(tracked));
		pendingMutations.add(tracked);
		return tracked;
	}
	function reloadPiResources(): Promise<PiResourceReloadSummary> {
		if (stopping) return Promise.reject(requestCancelled("Pi resource reload admission has stopped."));
		return scheduleReload();
	}
	function dispose(): Promise<void> {
		if (disposal) return disposal;
		stopping = true;
		disposal = (async () => {
			const mutations = await Promise.allSettled([...pendingMutations]);
			const reloads = await Promise.allSettled([activeReload, queuedReload]);
			reloadListeners.clear();
			throwAggregateFailures(
				[...mutations, ...reloads].flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to drain resource reconciliation",
			);
		})();
		return disposal;
	}
	return { onPiResourcesReloaded, reloadPiResources, mutateThenReloadPiResources, dispose };
}

export type ResourceReloadCoordinator = ReturnType<typeof createResourceReloadCoordinator>;
