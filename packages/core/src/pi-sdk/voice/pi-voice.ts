import { stat } from "node:fs/promises";
import {
	isPiVoiceSource,
	VOICE_PCM_MAX_BYTES,
	voiceOverviewSchema,
	voiceTranscriptSchema,
	type VoiceConfigureRequest,
	type VoiceTranscribeRequest,
} from "@ling/contracts/voice";
import { errorCode } from "@ling/contracts/ling-error";
import type { PiProjectServices } from "../projects/services";
import { createLingError, isLingError, toError, requestCapacityExceeded } from "../../ling-error";
import { loadPiVoiceModules, type PiVoiceModules, type PiVoiceSettings } from "./pi-voice-modules";

/** Reject truncated or noncanonical PCM instead of transcribing a different recording. */
export function decodeVoicePcm(encoded: string): Float32Array {
	const bytes = Buffer.from(encoded, "base64");
	if (
		bytes.length === 0 ||
		bytes.length > VOICE_PCM_MAX_BYTES ||
		bytes.length % 2 !== 0 ||
		bytes.toString("base64") !== encoded
	)
		throw new Error("Invalid voice recording: expected bounded 16 kHz mono PCM16");
	const samples = new Float32Array(bytes.length / 2);
	for (let index = 0; index < samples.length; index++) samples[index] = bytes.readInt16LE(index * 2) / 32768;
	return samples;
}

async function modelExists(settings: PiVoiceSettings): Promise<boolean> {
	try {
		return (await stat(settings.model.path)).isFile();
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

/** One admitted model operation per control worker; native models are released after every recording. */
export function createPiVoice(projects: Pick<PiProjectServices, "withOpenProject">) {
	const shutdown = new AbortController();
	let active: { cwd: string; controller: AbortController; task: Promise<unknown> } | null = null;
	const withModules = <T>(cwd: string, task: (modules: PiVoiceModules, source: string) => Promise<T>) =>
		projects
			.withOpenProject(cwd, async (services) => {
				shutdown.signal.throwIfAborted();
				const extension = services.resourceLoader
					.getExtensions()
					.extensions.find((candidate) => isPiVoiceSource(candidate.sourceInfo.source));
				if (!extension)
					throw new Error(
						"Pi Voice is unavailable in this project. Enable Voice input or its Pi package, then reload resources.",
					);
				return task(await loadPiVoiceModules(extension.resolvedPath), extension.sourceInfo.source);
			})
			.catch((cause: unknown) => {
				if (isLingError(cause)) throw cause;
				throw createLingError(
					{
						code: "VOICE_OPERATION_FAILED",
						category: "external",
						message: toError(cause).message.slice(0, 2_000) || "Voice operation failed",
						retryable: true,
						userAction: "retry",
					},
					cause,
				);
			});
	function exclusive<T>(cwd: string, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (active) return Promise.reject(requestCapacityExceeded("voice", 1, "Another voice operation is in progress"));
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, shutdown.signal, controller.signal]);
		combined.throwIfAborted();
		const operation = task(combined).finally(() => {
			if (active?.task === operation) active = null;
		});
		active = { cwd, controller, task: operation };
		return operation;
	}
	return {
		read(cwd: string) {
			return withModules(cwd, async (modules, source) => {
				const current = await modules.settings.readSettings();
				const configured = current.settings && (await modelExists(current.settings)) ? current.settings : null;
				return voiceOverviewSchema.parse({
					source,
					version: "0.1.0",
					configuration: configured
						? {
								modelId: configured.model.id,
								language: configured.transcriptionLanguage,
								chineseOutput: configured.chineseOutput,
							}
						: null,
					warning:
						current.warning ??
						(current.settings && !configured
							? "The configured voice model is missing. Select or download a model again."
							: null),
					models: modules.catalog.CATALOG_MODELS.map((model) => ({
						id: model.id,
						name: model.name,
						bytes: model.size,
						languages: model.languages,
						autoDetect: model.capabilities.languageDetection,
						downloaded: Boolean(modules.models.findCachedCatalogModel(model)),
					})),
				});
			});
		},
		configure(input: VoiceConfigureRequest, signal: AbortSignal) {
			return exclusive(input.cwd, signal, (operationSignal) =>
				withModules(input.cwd, async (modules) => {
					const model = modules.catalog.CATALOG_MODELS.find(
						(candidate) => candidate.id === input.configuration.modelId,
					);
					if (!model) throw new Error("Unknown voice model");
					const language = input.configuration.language;
					if (language === "auto" ? !model.capabilities.languageDetection : !model.languages.includes(language))
						throw new Error("This voice model does not support the selected language");
					const previous = await modules.settings.readSettings();
					// A failed read must never replace an existing Pi configuration with defaults.
					if (previous.warning) throw new Error(previous.warning);
					let path = modules.models.findCachedCatalogModel(model)?.path;
					if (!path && previous.settings?.model.id === model.id && (await modelExists(previous.settings)))
						path = previous.settings.model.path;
					if (!path) {
						if (!input.download) throw new Error("Download this voice model before using it");
						path = await modules.models.downloadCatalogModel(model, { signal: operationSignal });
					}
					operationSignal.throwIfAborted();
					await modules.settings.writeSettings(
						modules.settings.settingsForModel(model.id, path, {
							...previous.settings,
							transcriptionLanguage: language,
							chineseOutput: input.configuration.chineseOutput,
						}),
					);
				}),
			);
		},
		transcribe(input: VoiceTranscribeRequest, signal: AbortSignal) {
			return exclusive(input.cwd, signal, (operationSignal) =>
				withModules(input.cwd, async (modules) => {
					const current = await modules.settings.readSettings();
					if (current.warning) throw new Error(current.warning);
					if (!current.settings || !(await modelExists(current.settings)))
						throw new Error("Choose a local voice model before recording");
					const pcm = decodeVoicePcm(input.pcm);
					const service = new modules.service.TranscriptionService();
					try {
						const text = await service.transcribeFile(current.settings, pcm, operationSignal);
						operationSignal.throwIfAborted();
						return voiceTranscriptSchema.parse({ text });
					} finally {
						await service.shutdown();
					}
				}),
			);
		},
		cancelProject(cwd: string) {
			if (active?.cwd === cwd) active.controller.abort(new Error("The voice project is closing"));
		},
		async dispose() {
			shutdown.abort(new Error("Voice input is shutting down"));
			// The request owns its failure; disposal only waits for its native service to drain.
			await Promise.allSettled(active ? [active.task] : []);
		},
	};
}
