import type { PiModelProjection } from "../models/model-projection";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ModelState, SessionCommandCatalog, SessionQueue } from "@ling/contracts/session";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import type { SessionRuntimeSnapshot, SessionRuntimeStateSnapshot } from "@ling/core/pi-protocol/runtime-types";
import { createHash } from "node:crypto";
import { statSync, type BigIntStats } from "node:fs";
import { isAbsolute } from "node:path";
import { toError } from "../../ling-error";
import { hasPiMarkdownTransformers } from "../extensions/markdown-transformer";
import { type PiAgentSession, type PiAgentSessionRuntime, piBranchProjectionSource } from "../types";
import { runtimeDiagnostics } from "./runtime-factory";
import { projectPiBranchMessages, summarizePiBranchMessages } from "./session-message-projector";
import { readSessionOrigin } from "./session-origin";

/** Revision 1 adds initialized stock-renderer themes and nullable branch origins.
 * Bump when Ling's projection semantics change without a Pi or app version bump;
 * derived Host/Web snapshots must then rebuild from the unchanged session entries. */
const TRANSCRIPT_PROJECTION_REVISION = 1;

function updateProjectionFunction(hash: ReturnType<typeof createHash>, label: string, value: unknown): void {
	hash.update(label).update("\0");
	if (typeof value === "function") hash.update(Function.prototype.toString.call(value));
	hash.update("\0");
}

function updateProjectionFileIdentity(hash: ReturnType<typeof createHash>, resolvedPath: string): void {
	let file: BigIntStats;
	try {
		file = statSync(resolvedPath, { bigint: true });
	} catch (cause: unknown) {
		const error = toError(cause) as NodeJS.ErrnoException;
		// Package updates may replace an extension after Pi loaded its functions. The loaded
		// runtime remains authoritative, and the missing marker keeps that cache identity
		// distinct until resource reconciliation installs a new runtime generation.
		if (error.code === "ENOENT") {
			hash.update("extension-file-missing\0");
			return;
		}
		throw error;
	}
	hash
		.update(file.dev.toString())
		.update("\0")
		.update(file.ino.toString())
		.update("\0")
		.update(file.size.toString())
		.update("\0")
		.update(file.mtimeNs.toString())
		.update("\0")
		.update(file.ctimeNs.toString())
		.update("\0");
}

export function projectPiRuntimeDiagnostics(
	runtime: PiAgentSessionRuntime,
	sessionDiagnostics: readonly PiDiagnostic[],
): readonly PiDiagnostic[] {
	return [...runtimeDiagnostics(runtime), ...sessionDiagnostics];
}

export function projectPiRuntimeCommandCatalog(session: PiAgentSession): SessionCommandCatalog {
	const loader = session.resourceLoader;
	const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
		name: command.invocationName,
		description: command.description === undefined ? null : command.description,
		hasArgumentCompletions: typeof command.getArgumentCompletions === "function",
	}));
	// Mirrors Pi's enableSkillCommands: disabled skills stay loaded for the model
	// but are not offered as /skill:name commands.
	const skillCommandsEnabled = session.settingsManager.getEnableSkillCommands();
	return {
		extensions: extensionCommands,
		skills: skillCommandsEnabled
			? loader.getSkills().skills.map((skill) => ({
					name: skill.name,
					description: skill.description,
				}))
			: [],
		prompts: loader.getPrompts().prompts.map((prompt) => ({
			name: prompt.name,
			description: prompt.description,
			argumentHint: prompt.argumentHint === undefined ? null : prompt.argumentHint,
		})),
	};
}

export function projectPiRuntimeSnapshot(
	runtime: PiAgentSessionRuntime,
	sessionDiagnostics: readonly PiDiagnostic[],
	busy: boolean,
	queue: SessionQueue,
	markdownWidth: number,
): SessionRuntimeSnapshot {
	return {
		messages: projectPiBranchMessages(piBranchProjectionSource(runtime.session), {
			markdownWidth,
			includeLiveTurn: busy,
		}),
		...projectPiRuntimeStateSnapshot(runtime, sessionDiagnostics, busy, queue),
	};
}

export function projectPiRuntimeStateSnapshot(
	runtime: PiAgentSessionRuntime,
	sessionDiagnostics: readonly PiDiagnostic[],
	busy: boolean,
	queue: SessionQueue,
): SessionRuntimeStateSnapshot {
	return {
		busy,
		queue,
		diagnostics: [...runtimeDiagnostics(runtime), ...sessionDiagnostics],
	};
}

export function createPiRuntimeProjection(modelProjection: PiModelProjection) {
	const { projectSessionModels } = modelProjection;

	const projectionEnvironmentKeys = new WeakMap<PiAgentSession, string>();

	/** Fingerprints the loaded projection code, not mutable files after load. A WeakMap freezes the
	 * identity for this runtime; resource reloads already advance Ling's applied resource revision. */
	function projectionEnvironmentKey(session: PiAgentSession): string {
		const existing = projectionEnvironmentKeys.get(session);
		if (existing) return existing;
		const hash = createHash("sha256").update("ling-transcript-projection-environment\0");
		// Renderer function text does not capture imported Pi helpers or Ling's
		// normalization/initialization code. Include both owners of those semantics.
		hash.update(`pi-version\0${PI_VERSION}\0ling-projection\0${TRANSCRIPT_PROJECTION_REVISION}\0`);
		hash.update(`output-pad\0${session.settingsManager.getOutputPad()}\0`);
		for (const [name, value] of [...session.resourceLoader.getExtensions().runtime.flagValues].sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			hash
				.update("extension-flag\0")
				.update(name)
				.update("\0")
				.update(typeof value)
				.update("\0")
				.update(String(value));
		}
		const extensions = [...session.resourceLoader.getExtensions().extensions].sort((left, right) =>
			left.resolvedPath.localeCompare(right.resolvedPath),
		);
		for (const extension of extensions) {
			hash
				.update("extension\0")
				.update(extension.path)
				.update("\0")
				.update(extension.resolvedPath)
				.update("\0")
				.update(extension.sourceInfo.source)
				.update("\0")
				.update(extension.sourceInfo.scope)
				.update("\0")
				.update(extension.sourceInfo.origin)
				.update("\0");
			// Pi inline factories use a synthetic `<inline:name>` path. Their loaded function bodies
			// below are the authoritative identity; only disk-backed extensions have file metadata.
			if (isAbsolute(extension.resolvedPath)) {
				updateProjectionFileIdentity(hash, extension.resolvedPath);
			}
			updateProjectionFunction(hash, "markdown-transformer", extension.markdownTransformer);
			for (const [name, renderer] of [...extension.messageRenderers].sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				updateProjectionFunction(hash, `message-renderer\0${name}`, renderer);
			}
			for (const [name, renderer] of [...(extension.entryRenderers ?? [])].sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				updateProjectionFunction(hash, `entry-renderer\0${name}`, renderer);
			}
			for (const [name, tool] of [...extension.tools].sort(([left], [right]) => left.localeCompare(right))) {
				updateProjectionFunction(hash, `tool-render-call\0${name}`, tool.definition.renderCall);
				updateProjectionFunction(hash, `tool-render-result\0${name}`, tool.definition.renderResult);
			}
		}
		const key = hash.digest("base64url");
		projectionEnvironmentKeys.set(session, key);
		return key;
	}

	function transcriptCacheKey(session: PiAgentSession, markdownWidth: number): string | null {
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) return null;
		let file: BigIntStats;
		try {
			file = statSync(sessionFile, { bigint: true });
		} catch (cause: unknown) {
			const error = toError(cause) as NodeJS.ErrnoException;
			// Pi reserves a new session path before its first persisted entry. Until that write,
			// there is no durable transcript to identify and the renderer must not cache it.
			if (error.code === "ENOENT") return null;
			throw error;
		}
		const branch = session.sessionManager.getBranch();
		return createHash("sha256")
			.update(sessionFile)
			.update("\0")
			.update(file.dev.toString())
			.update("\0")
			.update(file.ino.toString())
			.update("\0")
			.update(file.size.toString())
			.update("\0")
			.update(file.mtimeNs.toString())
			.update("\0")
			.update(file.ctimeNs.toString())
			.update("\0")
			.update(session.sessionManager.getLeafId() ?? "")
			.update("\0")
			.update(String(branch.length))
			.update("\0projection-environment\0")
			.update(projectionEnvironmentKey(session))
			.update("\0markdown-width\0")
			.update(hasPiMarkdownTransformers(session) ? String(markdownWidth) : "unused")
			.digest("base64url");
	}

	function projectPiRuntimeModelState(session: PiAgentSession): ModelState {
		const models = projectSessionModels(session);
		const currentModel = session.model;
		const currentAvailable =
			currentModel !== undefined &&
			models.some((model) => model.provider === currentModel.provider && model.id === currentModel.id);
		return {
			models,
			...(currentAvailable
				? {
						currentProvider: currentModel.provider,
						currentModelId: currentModel.id,
					}
				: {}),
			thinkingLevel: session.thinkingLevel,
			availableThinkingLevels: currentAvailable ? session.getAvailableThinkingLevels() : [],
		};
	}

	function projectPiRuntimeSummary(
		session: PiAgentSession,
		createdAt: number,
		placeholderTitle: string,
		markdownWidth: number,
	) {
		const sessionName = session.sessionManager.getSessionName();
		const title = typeof sessionName === "string" && sessionName.trim().length > 0 ? sessionName : placeholderTitle;
		const branchSummary = summarizePiBranchMessages(session);
		const entries = session.sessionManager.getEntries();
		// Match Pi's disk catalog: activity spans every branch and ignores metadata/tool-only writes.
		const updatedAt = entries.reduce((latest, entry) => {
			if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) {
				return latest;
			}
			const messageTimestamp = entry.message.timestamp;
			const timestamp = typeof messageTimestamp === "number" ? messageTimestamp : Date.parse(entry.timestamp);
			return Number.isFinite(timestamp) && timestamp > 0 ? Math.max(latest, timestamp) : latest;
		}, createdAt);
		const sessionFile = session.sessionManager.getSessionFile();
		const parentSessionFilePath = session.sessionManager.getHeader()?.parentSession;
		return {
			sessionFilePath: typeof sessionFile === "string" ? sessionFile : "",
			...(parentSessionFilePath ? { parentSessionFilePath } : {}),
			manualFork: readSessionOrigin(session.sessionManager.getHeader(), entries).manualFork,
			title,
			updatedAt,
			messageCount: branchSummary.messageCount,
			preview: branchSummary.preview,
			transcriptCacheKey: transcriptCacheKey(session, markdownWidth),
		};
	}
	return { projectPiRuntimeModelState, projectPiRuntimeSummary };
}

export type PiRuntimeProjection = ReturnType<typeof createPiRuntimeProjection>;
