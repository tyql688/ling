import type { PiSettings } from "../settings/settings";
import type { PiSessionProjectAccess } from "./runtime-factory";
import type { PiTurnLifecycle } from "./turn-lifecycle";
import type { PiModelProjection } from "../models/model-projection";
import { createPiRuntimeFactory, type InitialRuntimeSelection } from "./runtime-factory";
import { createPiRuntimeProjection } from "./runtime-projection";
import type { PiExtensionUi } from "../extensions/extension-ui-context";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionRef, ThinkingLevel } from "@ling/contracts/session";
import type { SessionRuntimeForkSource } from "@ling/core/pi-protocol/runtime-port";
import { createLingError } from "../../ling-error";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../../logger";
import type { PiAgentSessionRuntime } from "../types";
import { createPiSessionRuntimeHandle, type PiSessionRuntimeHandle } from "./runtime";
import { readSessionFileSchemaVersion, sessionSchemaSkewDiagnostic } from "./session-schema";
import { recordManualForkOrigin } from "./session-origin";

const log = createLogger("pi-runtime-entrypoints");

type BeforeBindSession = (ref: SessionRef) => void | Promise<void>;

export function createPiSessionRuntimes({
	extensionUi,
	projects,
	turnLifecycle,
	modelProjection,
	settings,
}: {
	extensionUi: PiExtensionUi;
	projects: PiSessionProjectAccess;
	turnLifecycle: PiTurnLifecycle;
	modelProjection: PiModelProjection;
	settings: PiSettings;
}) {
	const runtimeFactory = createPiRuntimeFactory({
		projects,
		modelProjection,
		getPiDefaultTools: settings.getPiDefaultTools,
	});
	const projections = createPiRuntimeProjection(modelProjection);
	const runtimeServices = { extensionUi, projects, turnLifecycle, modelProjection, runtimeFactory, projections };
	const { getOpenProjectCwd, releasePiRuntimeServices } = projects;
	const { createRuntimeForSession } = runtimeFactory;

	const { clearExtensionUiState, unregisterApprovalRequester, unregisterExtensionUiRequester } = extensionUi.bridge;

	function clearUnmanagedRuntimeState(ref: SessionRef): void {
		unregisterApprovalRequester(ref);
		unregisterExtensionUiRequester(ref);
		clearExtensionUiState(ref);
	}

	async function initializeRuntimeHandle(
		ref: SessionRef,
		runtime: PiAgentSessionRuntime,
		createdAt?: number,
	): Promise<PiSessionRuntimeHandle> {
		let handle: PiSessionRuntimeHandle | null = null;
		try {
			handle = createPiSessionRuntimeHandle(runtimeServices, ref, runtime, createdAt);
			await handle.bindExtensions();
			return handle;
		} catch (error) {
			try {
				if (handle) {
					await handle.dispose();
				} else {
					try {
						await runtime.dispose();
					} catch (runtimeDisposeError) {
						try {
							runtime.session.dispose();
						} catch (sessionDisposeError) {
							log.error(`failed to force-dispose partially initialized session ${ref.sessionId}:`, sessionDisposeError);
						}
						throw runtimeDisposeError;
					} finally {
						releasePiRuntimeServices(runtime.services);
					}
				}
			} catch (disposeError) {
				log.error(`failed to dispose partially initialized session ${ref.sessionId}:`, disposeError);
			}
			throw error;
		}
	}

	async function createPiSessionRuntime(
		cwd: string,
		options: {
			beforeBind?: BeforeBindSession;
			model?: { provider: string; id: string };
			thinkingLevel?: ThinkingLevel;
		} = {},
	): Promise<PiSessionRuntimeHandle> {
		const canonicalCwd = getOpenProjectCwd(cwd);
		const sessionManager = SessionManager.create(canonicalCwd);
		const ref = {
			cwd: canonicalCwd,
			sessionId: sessionManager.getSessionId(),
		};
		const allocatedSessionFile = sessionManager.getSessionFile();
		try {
			await options.beforeBind?.(ref);
			const initialSelection: InitialRuntimeSelection = {
				...(options.model ? { model: options.model } : {}),
				...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			};
			const runtime = await createRuntimeForSession(ref, sessionManager, null, undefined, initialSelection);
			return await initializeRuntimeHandle(ref, runtime);
		} catch (error) {
			// Brand-new sessions may have already allocated a path; remove the empty artifact
			// so a failed bind does not leave a ghost session in the project catalog.
			const sessionFile = sessionManager.getSessionFile() ?? allocatedSessionFile;
			if (sessionFile) {
				await rm(sessionFile, { force: true }).catch((cleanupError: unknown) => {
					log.error(`failed to remove aborted new session file ${sessionFile}:`, cleanupError);
				});
			}
			// beforeBind may have registered dialog requesters for a never-managed id.
			clearUnmanagedRuntimeState(ref);
			throw error;
		}
	}

	async function resumePiSessionRuntime(
		cwd: string,
		sessionFilePath: string,
		createdAt: number,
		options: { beforeBind?: BeforeBindSession } = {},
	): Promise<PiSessionRuntimeHandle> {
		const canonicalCwd = getOpenProjectCwd(cwd);
		// Pi refuses to bind a runtime whose stored working directory is gone, and reports it as an
		// internal failure. Ling already knows the folder is missing, so it names that outcome here
		// and the renderer can offer the archived transcript instead.
		if (!existsSync(canonicalCwd)) {
			throw createLingError({
				code: "PROJECT_DIRECTORY_MISSING",
				category: "external",
				message: `The project directory no longer exists: ${canonicalCwd}`,
				retryable: false,
				details: { cwd: canonicalCwd },
			});
		}
		// Probe the header before the SDK consumes the file: a session written by a
		// newer Pi could otherwise silently drop entries this bundled SDK cannot parse.
		const schemaSkew = sessionSchemaSkewDiagnostic(await readSessionFileSchemaVersion(sessionFilePath));
		const sessionManager = SessionManager.open(sessionFilePath);
		const ref = {
			cwd: canonicalCwd,
			sessionId: sessionManager.getSessionId(),
		};
		try {
			// Do not delete the on-disk session on failure — resume must never destroy user history.
			await options.beforeBind?.(ref);
			const runtime = await createRuntimeForSession(ref, sessionManager);
			const handle = await initializeRuntimeHandle(ref, runtime, createdAt);
			if (schemaSkew) handle.addSessionDiagnostics([schemaSkew]);
			return handle;
		} catch (error) {
			// beforeBind installs runtime-owned requesters before runtime construction. A
			// failed resume never reaches managedSessions, so no registry teardown can reap them.
			clearUnmanagedRuntimeState(ref);
			throw error;
		}
	}

	async function forkPiSessionRuntime(
		source: SessionRuntimeForkSource,
		entryId: string,
		title: string,
		options: { beforeBind?: BeforeBindSession } = {},
	): Promise<PiSessionRuntimeHandle> {
		const originalPath = source.sessionFile;
		if (!originalPath) {
			throw new Error("Session has no history yet — send a message before forking");
		}
		const forkedSessionManager = SessionManager.open(originalPath);
		const forkedPath = forkedSessionManager.createBranchedSession(entryId);
		if (!forkedPath) throw new Error("Failed to fork session");
		if (resolve(forkedPath) === resolve(originalPath)) {
			throw new Error("Forked session path must differ from the source session path");
		}
		let newRef: SessionRef | null = null;
		try {
			recordManualForkOrigin(forkedSessionManager);
			forkedSessionManager.appendSessionInfo(title);
			newRef = {
				cwd: source.cwd,
				sessionId: forkedSessionManager.getSessionId(),
			};
			await options.beforeBind?.(newRef);
			const runtime = await createRuntimeForSession(newRef, forkedSessionManager);
			return await initializeRuntimeHandle(newRef, runtime);
		} catch (error) {
			if (newRef) clearUnmanagedRuntimeState(newRef);
			try {
				await rm(forkedPath, { force: true });
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					`Failed to initialize forked session and remove ${forkedPath}`,
				);
			}
			throw error;
		}
	}
	return { createPiSessionRuntime, resumePiSessionRuntime, forkPiSessionRuntime };
}

export type PiSessionRuntimes = ReturnType<typeof createPiSessionRuntimes>;
