import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readUtf8FileBounded } from "../../store/atomic-file-store";
import { VOICE_PACKAGE, type VoiceConfiguration } from "@ling/contracts/voice";
import { errorCode } from "@ling/contracts/ling-error";

const supportedManifest = z.object({ name: z.literal(VOICE_PACKAGE), version: z.literal("0.1.0") });

/** Unknown releases retain their original Pi commands until this adapter has been audited. */
export async function supportsPiVoice(entry: string): Promise<boolean> {
	const source = await readUtf8FileBounded(join(dirname(entry), "package.json"), 256 * 1024);
	return source !== undefined && supportedManifest.safeParse(JSON.parse(source)).success;
}

export interface VoiceModel {
	id: string;
	name: string;
	size: number;
	languages: readonly string[];
	capabilities: { languageDetection: boolean };
}
export interface PiVoiceSettings {
	version: 1;
	backend: { type: "transcribe-cpp" };
	shortcut: string;
	preferredLanguages: string[];
	transcriptionLanguage: string;
	chineseOutput: VoiceConfiguration["chineseOutput"];
	microphone: { type: "system-default" } | { type: "device"; name: string; occurrence: number };
	model: { source: "catalog"; id: string; path: string };
}
interface VoiceService {
	transcribeFile(settings: PiVoiceSettings, pcm: Float32Array, signal: AbortSignal): Promise<string>;
	shutdown(): Promise<void>;
}
export interface PiVoiceModules {
	settings: {
		readSettings(): Promise<{ settings?: PiVoiceSettings; warning?: string }>;
		settingsForModel(id: string, path: string, options: Partial<Omit<PiVoiceSettings, "model">>): PiVoiceSettings;
		writeSettings(settings: PiVoiceSettings): Promise<void>;
	};
	catalog: { CATALOG_MODELS: VoiceModel[] };
	models: {
		findCachedCatalogModel(model: VoiceModel): { path: string } | undefined;
		downloadCatalogModel(model: VoiceModel, options: { signal: AbortSignal }): Promise<string>;
	};
	service: { TranscriptionService: new () => VoiceService };
}

/** Version-specific adapter over the published source; never imports Pi SDK dist internals. */
export async function loadPiVoiceModules(entry: string): Promise<PiVoiceModules> {
	if (!(await supportsPiVoice(entry)))
		throw new Error("This Pi Voice version does not support Ling's voice interface. Supported version: 0.1.0.");
	// Pi may retain the workspace's package symlink. Jiti needs the package's real
	// directory so nested dependencies resolve equally in development and deployment.
	const directory = dirname(await realpath(entry));
	// Resolve .js-to-.ts imports just as Pi's extension loader does. Native libraries and the SDK
	// keep their normal Node identities; a fresh loader observes package replacement after reload.
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// Pi installs extensions without SDK peers; reuse Ling's embedded public SDK.
		alias: { "@earendil-works/pi-coding-agent": fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")) },
		nativeModules: ["@earendil-works/pi-coding-agent", "transcribe-cpp", "@picovoice/pvrecorder-node"],
	});
	const [settings, paths, catalog, models, service] = await Promise.all([
		jiti.import<PiVoiceModules["settings"]>(join(directory, "src/settings.ts")),
		jiti.import<{ settingsPath(): string }>(join(directory, "src/settings-path.ts")),
		jiti.import<PiVoiceModules["catalog"]>(join(directory, "src/catalog.ts")),
		jiti.import<PiVoiceModules["models"]>(join(directory, "src/models.ts")),
		jiti.import<PiVoiceModules["service"]>(join(directory, "src/transcription-service.ts")),
	]);
	return {
		settings: {
			...settings,
			async readSettings() {
				// Upstream migrates and deletes pi-transcribe.json when pi-voice.json is absent.
				// Merely opening Ling's settings must not move another extension's configuration.
				try {
					await stat(paths.settingsPath());
				} catch (error) {
					if (errorCode(error) === "ENOENT") return {};
					throw error;
				}
				return settings.readSettings();
			},
		},
		catalog,
		models,
		service,
	};
}
