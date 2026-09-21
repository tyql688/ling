import { LEGACY_USER_STATE_KEYS } from "@ling/contracts/legacy-user-state";
import { errorMessage } from "@ling/contracts/ling-error";
import {
	PREFERENCE_SCHEMA,
	PREFERENCE_VERSION,
	parseRendererPreferenceMeta,
	type PreferenceMeta,
} from "@ling/contracts/renderer-preferences";
import { utf8Bytes } from "@ling/contracts/text-validation";
/**
 * localStorage key table. Keys must stay stable (renaming loses user preferences);
 * the `ling:` prefix isolates them from other sources.
 */
export const RENDERER_PREFERENCE_KEYS = {
	theme: "ling:theme",
	skin: "ling:skin",
	skinExpression: "ling:skin-expression",
	skinSceneOverrides: "ling:skin-scene-overrides",
	skinCache: "ling:skin-cache",
	uiBootPreferences: "ling:ui-boot-preferences",
	language: "ling:language",
	sidebarCollapsed: "ling:sidebar-collapsed",
	pinnedProjectCwds: "ling:pinned-project-cwds",
	projectDisplayNames: "ling:project-display-names",
	sessionSeenAt: "ling:session-seen-at",
	sidebarProjectScope: "ling:sidebar-project-scope",
	lastConversationCwd: "ling:last-conversation-cwd",
	sidebarSortMode: "ling:sidebar-sort-mode",
	sidebarArchiveVisibility: "ling:sidebar-archive-visibility",
	changeReviewPanelWidth: "ling:change-review-panel-width",
	terminalPanelHeight: "ling:terminal-panel-height",
	// Preserve the saved value as native glass expands from the sidebar to the conversation.
	nativeTransparency: "ling:vibrancy-transparency",
	fontSmoothing: "ling:font-smoothing",
	sendShortcut: "ling:send-shortcut",
	composerEditorMode: "ling:composer-editor-mode",
	followUpBehavior: "ling:follow-up-behavior",
	projectLaunchTarget: "ling:project-launch-target",
	interfaceZoom: "ling:interface-zoom",
	showTodayUsage: "ling:show-today-usage",
	openSessionTabs: "ling:open-session-tabs",
	workbenchGeometry: "ling:workbench-geometry-v2.5",
	// Retired geometry keys remain owned so an explicit preference reset can remove them.
	workbenchSideLayout: "ling:workbench-side-layout",
	workbenchSideWidth: "ling:workbench-side-width",
} as const;

type RendererPreferenceKey = (typeof RENDERER_PREFERENCE_KEYS)[keyof typeof RENDERER_PREFERENCE_KEYS];

/** Dedicated key for schema metadata; kept apart from value keys so the version can be validated once. */
// Legacy user-source metadata remains untouched during device view resets.
const PREFERENCE_META_KEY = "ling:view-preferences-meta";
/**
 * Byte cap per preference value. Enums/booleans get a small cap; path maps and sessionSeen
 * get MiB-scale caps (upper bound of project/session counts); over-cap keys are dropped
 * to keep localStorage from filling up.
 */
const MAX_PREFERENCE_BYTES: Record<RendererPreferenceKey, number> = {
	[RENDERER_PREFERENCE_KEYS.theme]: 32,
	[RENDERER_PREFERENCE_KEYS.skin]: 128,
	[RENDERER_PREFERENCE_KEYS.skinExpression]: 32,
	// Per-package scene choices for the bounded gallery, without copying manifests or artwork.
	[RENDERER_PREFERENCE_KEYS.skinSceneOverrides]: 32 * 1024,
	// Resolved light and dark skin modes, mirrored for first-paint application in theme-init.js.
	[RENDERER_PREFERENCE_KEYS.skinCache]: 32 * 1024,
	[RENDERER_PREFERENCE_KEYS.uiBootPreferences]: 8192,
	[RENDERER_PREFERENCE_KEYS.language]: 32,
	[RENDERER_PREFERENCE_KEYS.sidebarCollapsed]: 8,
	[RENDERER_PREFERENCE_KEYS.pinnedProjectCwds]: 1024 * 1024,
	[RENDERER_PREFERENCE_KEYS.projectDisplayNames]: 1024 * 1024,
	[RENDERER_PREFERENCE_KEYS.sessionSeenAt]: 2 * 1024 * 1024,
	[RENDERER_PREFERENCE_KEYS.sidebarProjectScope]: 1024 * 1024,
	// One JSON-encoded absolute path.
	[RENDERER_PREFERENCE_KEYS.lastConversationCwd]: 16 * 1024,
	[RENDERER_PREFERENCE_KEYS.sidebarSortMode]: 32,
	[RENDERER_PREFERENCE_KEYS.sidebarArchiveVisibility]: 32,
	[RENDERER_PREFERENCE_KEYS.changeReviewPanelWidth]: 32,
	[RENDERER_PREFERENCE_KEYS.terminalPanelHeight]: 32,
	[RENDERER_PREFERENCE_KEYS.nativeTransparency]: 16,
	[RENDERER_PREFERENCE_KEYS.fontSmoothing]: 32,
	[RENDERER_PREFERENCE_KEYS.sendShortcut]: 64,
	[RENDERER_PREFERENCE_KEYS.composerEditorMode]: 16,
	[RENDERER_PREFERENCE_KEYS.followUpBehavior]: 32,
	[RENDERER_PREFERENCE_KEYS.projectLaunchTarget]: 64,
	[RENDERER_PREFERENCE_KEYS.interfaceZoom]: 16,
	[RENDERER_PREFERENCE_KEYS.showTodayUsage]: 8,
	[RENDERER_PREFERENCE_KEYS.openSessionTabs]: 64_000,
	// Two panel percentages plus their stable ids; anything larger is not a workbench layout.
	[RENDERER_PREFERENCE_KEYS.workbenchSideLayout]: 128,
	[RENDERER_PREFERENCE_KEYS.workbenchGeometry]: 128,
	// Retired pixel width is kept only for the bounded legacy read/reset contract.
	[RENDERER_PREFERENCE_KEYS.workbenchSideWidth]: 32,
};
/** All keys owned by this module (meta included); preference reset touches only this set. */
const OWNED_PREFERENCE_KEYS = [
	PREFERENCE_META_KEY,
	...Object.values(RENDERER_PREFERENCE_KEYS).filter((key) => !LEGACY_USER_STATE_KEYS.includes(key)),
];

type RendererPreferenceSchemaStatus = "ready" | "corrupt" | "futureVersion";
type RendererPreferenceValueStatus = "missing" | "valid" | "invalid";

interface RendererPreferenceDiagnostic {
	key: string;
	code: "CORRUPT_SCHEMA" | "FUTURE_VERSION" | "INVALID_VALUE" | "VALUE_TOO_LARGE";
	message: string;
}

interface RendererPreferenceInitialization {
	status: RendererPreferenceSchemaStatus;
	version: number | null;
	diagnostics: readonly RendererPreferenceDiagnostic[];
}

interface RendererPreferenceRead<Value> {
	status: RendererPreferenceValueStatus;
	value: Value;
}

let initialization: RendererPreferenceInitialization | null = null;
const valueDiagnostics = new Map<RendererPreferenceKey, RendererPreferenceDiagnostic>();

function currentMeta(writtenAt = Date.now()): PreferenceMeta {
	return { schema: PREFERENCE_SCHEMA, version: PREFERENCE_VERSION, writtenAt };
}

function inspectAllowedValues(storage: Storage): RendererPreferenceDiagnostic[] {
	const diagnostics: RendererPreferenceDiagnostic[] = [];
	for (const key of Object.values(RENDERER_PREFERENCE_KEYS)) {
		const raw = storage.getItem(key);
		if (raw === null || utf8Bytes(raw) <= MAX_PREFERENCE_BYTES[key]) continue;
		diagnostics.push({
			key,
			code: "VALUE_TOO_LARGE",
			message: `Stored renderer preference exceeds ${MAX_PREFERENCE_BYTES[key]} bytes.`,
		});
	}
	return diagnostics;
}

export function initializeRendererPreferences(storage?: Storage): RendererPreferenceInitialization {
	if (initialization !== null) return initialization;
	const target = storage ?? localStorage;
	try {
		const raw = target.getItem(PREFERENCE_META_KEY);
		if (raw === null) {
			// Pre-versioning installs wrote owned keys with no metadata. A headerless store is a
			// documented migration boundary (same policy as the app settings file): stamp the
			// current schema and keep the values — each read validates its own key anyway.
			target.setItem(PREFERENCE_META_KEY, JSON.stringify(currentMeta()));
			initialization = { status: "ready", version: PREFERENCE_VERSION, diagnostics: inspectAllowedValues(target) };
			return initialization;
		}
		const meta = parseRendererPreferenceMeta(raw);
		if ("futureVersion" in meta) {
			initialization = {
				status: "futureVersion",
				version: meta.futureVersion,
				diagnostics: [
					{
						key: PREFERENCE_META_KEY,
						code: "FUTURE_VERSION",
						message: `Renderer preferences were written by future schema version ${meta.futureVersion}.`,
					},
				],
			};
			return initialization;
		}
		initialization = { status: "ready", version: meta.version, diagnostics: inspectAllowedValues(target) };
		return initialization;
	} catch (error) {
		initialization = {
			status: "corrupt",
			version: null,
			diagnostics: [
				{
					key: PREFERENCE_META_KEY,
					code: "CORRUPT_SCHEMA",
					message: errorMessage(error),
				},
			],
		};
		return initialization;
	}
}

export function getRendererPreferenceDiagnostics(): readonly RendererPreferenceDiagnostic[] {
	const schema = initializeRendererPreferences();
	return [...schema.diagnostics, ...valueDiagnostics.values()];
}

function assertWritableSchema(storage: Storage): void {
	const state = initializeRendererPreferences(storage);
	if (state.status !== "ready") {
		throw new Error(`Renderer preferences are ${state.status}; preserving the stored future/corrupt data`);
	}
}

function recordInvalid(key: RendererPreferenceKey, code: "INVALID_VALUE" | "VALUE_TOO_LARGE", message: string): void {
	valueDiagnostics.set(key, { key, code, message });
}

export function readRendererPreference<Value>(
	key: RendererPreferenceKey,
	fallback: Value,
	parse: (raw: string) => Value | null,
	storage: Storage = localStorage,
): RendererPreferenceRead<Value> {
	initializeRendererPreferences(storage);
	try {
		const raw = storage.getItem(key);
		if (raw === null) return { status: "missing", value: fallback };
		if (utf8Bytes(raw) > MAX_PREFERENCE_BYTES[key]) {
			recordInvalid(key, "VALUE_TOO_LARGE", `Stored renderer preference exceeds ${MAX_PREFERENCE_BYTES[key]} bytes.`);
			return { status: "invalid", value: fallback };
		}
		const value = parse(raw);
		if (value === null) {
			recordInvalid(key, "INVALID_VALUE", "Stored renderer preference failed validation.");
			return { status: "invalid", value: fallback };
		}
		valueDiagnostics.delete(key);
		return { status: "valid", value };
	} catch (error) {
		recordInvalid(key, "INVALID_VALUE", errorMessage(error));
		return { status: "invalid", value: fallback };
	}
}

export function writeRendererPreference(
	key: RendererPreferenceKey,
	raw: string,
	storage: Storage = localStorage,
): void {
	assertWritableSchema(storage);
	const bytes = utf8Bytes(raw);
	if (bytes > MAX_PREFERENCE_BYTES[key]) {
		throw new Error(`Renderer preference ${key} exceeds ${MAX_PREFERENCE_BYTES[key]} bytes`);
	}
	storage.setItem(key, raw);
	valueDiagnostics.delete(key);
}

export function readJsonPreference<Value>(
	key: RendererPreferenceKey,
	fallback: Value,
	validate: (value: unknown) => Value | null,
): RendererPreferenceRead<Value> {
	return readRendererPreference(key, fallback, (raw) => validate(JSON.parse(raw) as unknown));
}

export function resetRendererPreferences(storage: Storage = localStorage): RendererPreferenceInitialization {
	const previousValues = new Map<string, string | null>();
	for (const key of OWNED_PREFERENCE_KEYS) previousValues.set(key, storage.getItem(key));

	try {
		for (const key of OWNED_PREFERENCE_KEYS) storage.removeItem(key);
		storage.setItem(PREFERENCE_META_KEY, JSON.stringify(currentMeta()));
	} catch (resetError) {
		const rollbackErrors: unknown[] = [];
		for (const [key, value] of previousValues) {
			try {
				if (value === null) storage.removeItem(key);
				else storage.setItem(key, value);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[resetError, ...rollbackErrors],
				"Renderer preference reset failed and could not restore every owned key",
			);
		}
		throw resetError;
	}

	valueDiagnostics.clear();
	initialization = { status: "ready", version: PREFERENCE_VERSION, diagnostics: [] };
	return initialization;
}
