import type { AppSettingsReadResult, AppSettingsSnapshot, AppSettingsUpdate } from "@ling/contracts/application";
import {
	PROJECT_LAUNCH_TARGET_IDS,
	PROJECT_LAUNCH_TARGET_KIND_BY_ID,
	type ProjectLaunchPreferences,
	type ProjectLaunchTargetKind,
} from "@ling/contracts/project";
import { isRecord as isDatasetRecord } from "@ling/contracts/records";
import { TERMINAL_PROFILE_ID_MAX_CHARS } from "@ling/contracts/terminal";
import { hasControlCharacter } from "@ling/contracts/text-validation";
import { requestCancelled } from "@ling/core/ling-error";
import { readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import {
	DatasetReadError,
	datasetCorruption,
	datasetStoreStatusFromError,
	inspectDatasetVersion,
	parseDatasetJson,
} from "@ling/host/storage/dataset-envelope";
import { join } from "node:path";
import { z } from "zod";
import type { HostDatabase } from "../../storage/database";

/** Settings file name under userData; decoupled from the dataset schema — renaming loses local preferences. */
const APP_SETTINGS_FILE = "settings.json";

/** Dataset schema identifier; validated when reading from disk to prevent cross-reading Pi's or another settings.json. */
const APP_SETTINGS_DATASET_ID = "ling/app-settings";

/** Current envelope version; v5 added the @file .gitignore preference, so older files inherit its false default. */
const APP_SETTINGS_VERSION = 6;

/**
 * Oldest historical version eligible for automatic upgrade. v1 had no notification toggles;
 * anything older is refused outright rather than guessing fields.
 */
const APP_SETTINGS_MIN_UPGRADE_VERSION = 1;

/** Settings file byte cap. 64KiB far exceeds legitimate preferences; larger is treated as corruption/injection and refused. */
const APP_SETTINGS_MAX_BYTES = 64 * 1024;

/**
 * Factory-default preferences. The only boundary default source when the file is corrupt
 * or missing: notifications on, no tray residency on window close, launcher/terminal
 * profile null until configured.
 */
const DEFAULT_APP_SETTINGS: AppSettingsSnapshot = {
	keepRunningOnWindowClose: false,
	disableHardwareAcceleration: false,
	notifyBackgroundCompletion: true,
	notifyAttentionNeeded: true,
	playNotificationSounds: true,
	projectLaunchers: {
		editor: null,
		terminal: null,
		"file-manager": null,
	},
	integratedTerminalProfileId: null,
	fileMentionsRespectGitignore: false,
	keepAwakeWhileRunning: false,
};

/** Boolean setting-key allowlist; parsing/patching accepts only this table, so unknown keys never reach disk. */
const BOOLEAN_APP_SETTING_KEYS = [
	"keepRunningOnWindowClose",
	"disableHardwareAcceleration",
	"notifyBackgroundCompletion",
	"notifyAttentionNeeded",
	"playNotificationSounds",
	"fileMentionsRespectGitignore",
	"keepAwakeWhileRunning",
] as const;

/** All writable setting keys (boolean + object); aligned with the DEFAULT/snapshot shape for strict merging. */
const APP_SETTING_KEYS = [...BOOLEAN_APP_SETTING_KEYS, "projectLaunchers", "integratedTerminalProfileId"] as const;

/** Closed set of project launcher kinds; one-to-one with shared target ids — parsing rejects illegal kinds. */
const PROJECT_LAUNCH_KINDS = ["file-manager", "editor", "terminal"] as const;

interface StoredAppSettings {
	schema: typeof APP_SETTINGS_DATASET_ID;
	version: typeof APP_SETTINGS_VERSION;
	writtenAt: number;
	data: AppSettingsSnapshot;
}

function assertTerminalProfileId(value: unknown, label: string): string | null {
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > TERMINAL_PROFILE_ID_MAX_CHARS ||
		hasControlCharacter(value)
	) {
		throw datasetCorruption(APP_SETTINGS_DATASET_ID, `${label} has an invalid integrated terminal profile.`);
	}
	return value;
}

function assertProjectLaunchers(value: unknown, label: string): ProjectLaunchPreferences {
	if (
		!isDatasetRecord(value) ||
		Object.keys(value).some((key) => !PROJECT_LAUNCH_KINDS.includes(key as ProjectLaunchTargetKind))
	) {
		throw datasetCorruption(APP_SETTINGS_DATASET_ID, `${label} has invalid project launcher fields.`);
	}
	const result = { ...DEFAULT_APP_SETTINGS.projectLaunchers };
	for (const kind of PROJECT_LAUNCH_KINDS) {
		const targetId = value[kind];
		if (
			targetId !== null &&
			(typeof targetId !== "string" ||
				!PROJECT_LAUNCH_TARGET_IDS.includes(targetId as never) ||
				PROJECT_LAUNCH_TARGET_KIND_BY_ID[targetId as (typeof PROJECT_LAUNCH_TARGET_IDS)[number]] !== kind)
		) {
			throw datasetCorruption(APP_SETTINGS_DATASET_ID, `${label} has an invalid ${kind} launcher.`);
		}
		result[kind] = targetId as (typeof PROJECT_LAUNCH_TARGET_IDS)[number] | null;
	}
	return result;
}

function assertSettingsData(value: unknown, label: string, version = APP_SETTINGS_VERSION): AppSettingsSnapshot {
	if (!isDatasetRecord(value) || Object.keys(value).some((key) => !APP_SETTING_KEYS.includes(key as never))) {
		throw datasetCorruption(APP_SETTINGS_DATASET_ID, `${label} contains unknown fields.`);
	}
	const settings: AppSettingsSnapshot = {
		...DEFAULT_APP_SETTINGS,
		projectLaunchers: { ...DEFAULT_APP_SETTINGS.projectLaunchers },
	};
	for (const key of BOOLEAN_APP_SETTING_KEYS) {
		const field = value[key];
		if (field === undefined) {
			if (
				version === 1 ||
				(key === "playNotificationSounds" && version < 4) ||
				(key === "fileMentionsRespectGitignore" && version < 5) ||
				(key === "keepAwakeWhileRunning" && version < 6)
			)
				continue;
			throw datasetCorruption(APP_SETTINGS_DATASET_ID, `${label} is missing its ${key} value.`);
		}
		if (typeof field !== "boolean") {
			throw datasetCorruption(APP_SETTINGS_DATASET_ID, `${label} has an invalid ${key} value.`);
		}
		settings[key] = field;
	}
	if (version < 3) return settings;
	if (!Object.hasOwn(value, "projectLaunchers") || !Object.hasOwn(value, "integratedTerminalProfileId")) {
		throw datasetCorruption(APP_SETTINGS_DATASET_ID, `${label} is missing its terminal or launcher preferences.`);
	}
	settings.projectLaunchers = assertProjectLaunchers(value.projectLaunchers, label);
	settings.integratedTerminalProfileId = assertTerminalProfileId(value.integratedTerminalProfileId, label);
	return settings;
}

function parseAppSettings(raw: string): AppSettingsSnapshot {
	const value = parseDatasetJson(raw, APP_SETTINGS_DATASET_ID);
	if (!isDatasetRecord(value)) {
		throw datasetCorruption(APP_SETTINGS_DATASET_ID, "Ling settings must be a JSON object.");
	}
	inspectDatasetVersion(value, {
		datasetId: APP_SETTINGS_DATASET_ID,
		schema: APP_SETTINGS_DATASET_ID,
		currentVersion: APP_SETTINGS_VERSION,
		minSupportedVersion: APP_SETTINGS_MIN_UPGRADE_VERSION,
	});
	if (
		Object.keys(value).some((key) => key !== "schema" && key !== "version" && key !== "writtenAt" && key !== "data") ||
		!Number.isSafeInteger(value.writtenAt) ||
		(value.writtenAt as number) < 0
	) {
		throw datasetCorruption(APP_SETTINGS_DATASET_ID, "Ling settings envelope is invalid.");
	}
	return assertSettingsData(value.data, "Ling settings", value.version as number);
}

function serializeAppSettings(settings: AppSettingsSnapshot, writtenAt = Date.now()): string {
	const data = assertSettingsData(settings, "Ling settings writer");
	if (!Number.isSafeInteger(writtenAt) || writtenAt < 0) {
		throw datasetCorruption(APP_SETTINGS_DATASET_ID, "Ling settings writtenAt is invalid.");
	}
	const stored: StoredAppSettings = {
		schema: APP_SETTINGS_DATASET_ID,
		version: APP_SETTINGS_VERSION,
		writtenAt,
		data,
	};
	return `${JSON.stringify(stored, null, 2)}\n`;
}

function copyAppSettings(settings: AppSettingsSnapshot): AppSettingsSnapshot {
	return { ...settings, projectLaunchers: { ...settings.projectLaunchers } };
}

/** Owns the settings snapshot and accepted writes for one Host lifetime. */
export function createAppSettingsStore({ userDataDir, database }: { userDataDir: string; database: HostDatabase }) {
	let mutationTail: Promise<void> = Promise.resolve();
	let disposePromise: Promise<void> | null = null;
	let disposing = false;

	const settingsFilePath = join(userDataDir, APP_SETTINGS_FILE);

	function enqueueAppSettingsMutation<Result>(mutate: () => Promise<Result>): Promise<Result> {
		if (disposing) {
			return Promise.reject(requestCancelled("The app settings update was cancelled because Ling is shutting down."));
		}
		const operation = mutationTail.then(mutate);
		mutationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Last successfully resolved snapshot, kept current by every read/write below; backs the hot-path getter. */
	let cachedAppSettings: AppSettingsSnapshot | null = null;

	function replace(settings: AppSettingsSnapshot) {
		// Preserve the historical settings acceptance and byte budget while moving publication into one transaction.
		serializeAppSettings(settings);
		database.transaction(() => {
			database.run("DELETE FROM app_settings");
			for (const [key, value] of Object.entries(settings))
				database.run("INSERT INTO app_settings(key,value) VALUES(?,?)", key, JSON.stringify(value));
		});
	}
	function ensureImported() {
		database.importLegacy({
			key: APP_SETTINGS_DATASET_ID,
			source: settingsFilePath,
			read() {
				const contents = readUtf8FileSyncBounded(settingsFilePath, APP_SETTINGS_MAX_BYTES);
				return contents === undefined ? copyAppSettings(DEFAULT_APP_SETTINGS) : parseAppSettings(contents);
			},
			publish: replace,
		});
	}
	function getAppSettings(): AppSettingsSnapshot {
		ensureImported();
		const data: Record<string, unknown> = {};
		for (const row of database.all("SELECT key,value FROM app_settings")) {
			const stored = z.object({ key: z.string(), value: z.string() }).parse(row);
			Object.defineProperty(data, stored.key, {
				value: parseDatasetJson(stored.value, APP_SETTINGS_DATASET_ID),
				enumerable: true,
			});
		}
		const settings = assertSettingsData(data, "Ling database settings");
		cachedAppSettings = copyAppSettings(settings);
		return settings;
	}

	/**
	 * Hot-path read for per-keystroke IPC handlers: serves the cached snapshot without touching
	 * disk. Falls back to defaults on a corrupt file — that is the documented boundary default;
	 * the settings page still surfaces the corruption via readAppSettings.
	 */
	function getAppSettingsFast(): AppSettingsSnapshot {
		if (cachedAppSettings === null) {
			try {
				return getAppSettings();
			} catch {
				cachedAppSettings = copyAppSettings(DEFAULT_APP_SETTINGS);
			}
		}
		return copyAppSettings(cachedAppSettings);
	}

	function readAppSettings(): AppSettingsReadResult {
		try {
			return { status: "ready", settings: getAppSettings() };
		} catch (error) {
			return datasetStoreStatusFromError(error);
		}
	}

	async function updateAppSettings(update: AppSettingsUpdate): Promise<AppSettingsSnapshot> {
		return enqueueAppSettingsMutation(async () => {
			try {
				const current = getAppSettings();
				let next: AppSettingsSnapshot;
				switch (update.type) {
					case "keepRunningOnWindowClose":
					case "disableHardwareAcceleration":
					case "notifyBackgroundCompletion":
					case "notifyAttentionNeeded":
					case "playNotificationSounds":
					case "fileMentionsRespectGitignore":
					case "keepAwakeWhileRunning":
						next = { ...current, [update.type]: update.enabled };
						break;
					case "projectLauncher":
						if (update.targetId !== null && PROJECT_LAUNCH_TARGET_KIND_BY_ID[update.targetId] !== update.kind) {
							throw new Error("Project launcher target does not match its category");
						}
						next = {
							...current,
							projectLaunchers: { ...current.projectLaunchers, [update.kind]: update.targetId },
						};
						break;
					case "integratedTerminalProfile":
						next = {
							...current,
							integratedTerminalProfileId: assertTerminalProfileId(update.profileId, "Ling settings update"),
						};
						break;
				}
				replace(next);
				cachedAppSettings = copyAppSettings(next);
				return next;
			} catch (cause) {
				throw new Error("Ling could not update app settings.", { cause });
			}
		});
	}

	async function resetAppSettings(): Promise<AppSettingsSnapshot> {
		return enqueueAppSettingsMutation(async () => {
			let readError: unknown = null;
			try {
				getAppSettings();
			} catch (error) {
				readError = error;
			}
			if (readError === null) throw new Error("App settings recovery is not required");
			if (!(readError instanceof DatasetReadError)) {
				throw new Error("Ling app settings are temporarily unavailable.", { cause: readError });
			}
			const reset = copyAppSettings(DEFAULT_APP_SETTINGS);
			try {
				database.transaction(() => {
					replace(reset);
					database.markImported(APP_SETTINGS_DATASET_ID, settingsFilePath);
				});
			} catch (cause) {
				throw new Error("Ling could not reset app settings.", { cause });
			}
			cachedAppSettings = copyAppSettings(reset);
			return reset;
		});
	}

	/** Stops admitting app settings mutations and drains every write accepted before shutdown. */
	function dispose(): Promise<void> {
		if (disposePromise) return disposePromise;
		disposing = true;
		disposePromise = mutationTail;
		return disposePromise;
	}
	return { getAppSettings, getAppSettingsFast, readAppSettings, updateAppSettings, resetAppSettings, dispose };
}

export type AppSettingsStore = ReturnType<typeof createAppSettingsStore>;
