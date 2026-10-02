import { PI_DEFAULT_TOOL_NAMES, type PiSettingsSnapshot, type PiSettingsUpdate } from "@ling/contracts/pi-settings";
import { createPersistedSettingsMutationQueue } from "./persisted-settings";

export type PiSettingsChange = PiSettingsUpdate | ((current: PiSettingsSnapshot) => PiSettingsUpdate);

/** Projects requested values while Pi owns persistence and live resource reconciliation. */
function previewSettings(current: PiSettingsSnapshot, update: PiSettingsUpdate): PiSettingsSnapshot {
	switch (update.type) {
		case "defaultModel":
			return { ...current, defaultProvider: update.provider, defaultModel: update.modelId };
		case "thinkingLevel":
			return { ...current, defaultThinkingLevel: update.level };
		case "defaultTools":
			return {
				...current,
				defaultTools: update.tools ?? [...PI_DEFAULT_TOOL_NAMES],
				defaultToolsConfigured: update.tools !== null,
			};
		case "codemode":
			return {
				...current,
				codemode: {
					mode: update.settings.mode ?? current.codemode.mode,
					inlineBudget: update.settings.inlineBudget ?? current.codemode.inlineBudget,
				},
			};
		case "compaction":
			return { ...current, compactionEnabled: update.enabled };
		case "cacheWarming":
			return { ...current, cacheWarming: update.mode };
		case "retry":
			return { ...current, retryEnabled: update.enabled };
		case "blockImages":
			return { ...current, blockImages: update.blocked };
		case "imageAutoResize":
		case "installTelemetry":
		case "analytics":
		case "enableSkillCommands":
			return { ...current, [update.type]: update.enabled };
		case "defaultProjectTrust":
			return { ...current, defaultProjectTrust: update.trust };
		case "steeringMode":
		case "followUpMode":
			return { ...current, [update.type]: update.mode };
		case "httpIdleTimeoutMs":
			return { ...current, httpIdleTimeoutMs: update.timeoutMs };
		// Text and number fields own their editable drafts and save indicators.
		case "compactionModel":
		case "compactionTokens":
		case "retryTuning":
		case "shellPath":
		case "shellCommandPrefix":
		case "npmCommand":
			return current;
	}
}

interface SettingsMutationState {
	snapshot: PiSettingsSnapshot | null;
	pending: ReadonlySet<string>;
	error: { key: string; cause: unknown } | null;
}

function mutationKey(update: PiSettingsUpdate): string {
	switch (update.type) {
		case "codemode":
			return `codemode:${Object.keys(update.settings).sort().join(",")}`;
		case "compactionTokens":
		case "retryTuning":
			return `${update.type}:${update.field}`;
		case "compactionModel":
			return `compactionModel:${update.provider}/${update.modelId}:${update.override === null ? "reset" : Object.keys(update.override).sort().join(",")}`;
		default:
			return update.type;
	}
}

/** Keeps independent pending choices visible as serialized writes settle or fail. */
export function createPiSettingsMutations(api: {
	get(): Promise<PiSettingsSnapshot>;
	update(update: PiSettingsUpdate): Promise<PiSettingsSnapshot>;
}) {
	const queue = createPersistedSettingsMutationQueue();
	const listeners = new Set<() => void>();
	const pending = new Map<
		string,
		{ preview: (current: PiSettingsSnapshot) => PiSettingsSnapshot; result: Promise<boolean> }
	>();
	let saved: PiSettingsSnapshot | null = null;
	let state: SettingsMutationState = { snapshot: null, pending: new Set(), error: null };
	let generation = 0;
	let settled: Promise<unknown> = Promise.resolve();

	function publish(error = state.error) {
		let snapshot = saved;
		if (snapshot) for (const entry of pending.values()) snapshot = entry.preview(snapshot);
		state = { snapshot, pending: new Set(pending.keys()), error };
		for (const listener of listeners) listener();
	}

	function run(
		key: string,
		preview: (current: PiSettingsSnapshot) => PiSettingsSnapshot,
		mutate: () => Promise<PiSettingsSnapshot>,
	) {
		const existing = pending.get(key);
		if (existing) return existing.result;
		const owner = generation;
		const result = queue.run(mutate, api.get).then(({ result }) => {
			if (owner !== generation) return result.status === "saved";
			pending.delete(key);
			if (result.status === "saved") saved = result.value;
			else if (result.persisted.status === "ready") saved = result.persisted.value;
			publish(result.status === "failed" ? { key, cause: result.error } : state.error);
			return result.status === "saved";
		});
		pending.set(key, { preview, result });
		settled = result;
		publish(state.error?.key === key ? null : state.error);
		return result;
	}

	return {
		getSnapshot: () => state,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		whenSettled: () => settled,
		replace(value: PiSettingsSnapshot) {
			saved = value;
			publish(null);
		},
		apply(change: PiSettingsChange, key?: string): Promise<boolean> {
			if (!state.snapshot) return Promise.resolve(false);
			const resolve = (current: PiSettingsSnapshot) => (typeof change === "function" ? change(current) : change);
			let update: PiSettingsUpdate;
			try {
				update = resolve(state.snapshot);
			} catch (cause) {
				publish({ key: key ?? "settings", cause });
				return Promise.resolve(false);
			}
			return run(
				key ?? mutationKey(update),
				(current) => previewSettings(current, resolve(current)),
				async () => api.update(typeof change === "function" ? resolve(await api.get()) : update),
			);
		},
		repair(mutate: () => Promise<PiSettingsSnapshot>) {
			return run("httpIdleTimeoutMs", (current) => current, mutate);
		},
		invalidate() {
			generation += 1;
			pending.clear();
			publish();
		},
	};
}
