import type { PiExtensionUi } from "./extension-ui-context";
import type { SessionRef } from "@ling/contracts/session";
import { createUnsupportedExtensionUiError } from "../../pi-protocol/extension-ui";
import { createLogger } from "../../logger";
import type { PiModelProjection } from "../models/model-projection";
import type { PiAgentSessionRuntime, PiExtensionBindings } from "../types";

const log = createLogger("pi-sdk");

type PiRuntimeNewSessionOptions = Parameters<PiAgentSessionRuntime["newSession"]>[0];
type PiRuntimeForkOptions = Parameters<PiAgentSessionRuntime["fork"]>[1];
type PiRuntimeNavigateTreeOptions = Parameters<PiAgentSessionRuntime["session"]["navigateTree"]>[1];
type PiRuntimeSwitchSessionOptions = Parameters<PiAgentSessionRuntime["switchSession"]>[1];
type PiRuntimeNewSessionResult = Awaited<ReturnType<PiAgentSessionRuntime["newSession"]>>;
type PiRuntimeForkResult = Awaited<ReturnType<PiAgentSessionRuntime["fork"]>>;
type PiRuntimeNavigateTreeResult = Awaited<ReturnType<PiAgentSessionRuntime["session"]["navigateTree"]>>;
type PiRuntimeSwitchSessionResult = Awaited<ReturnType<PiAgentSessionRuntime["switchSession"]>>;

interface PiExtensionCommandSessionActions {
	newSession(options?: PiRuntimeNewSessionOptions): Promise<PiRuntimeNewSessionResult>;
	fork(entryId: string, options?: PiRuntimeForkOptions): Promise<PiRuntimeForkResult>;
	navigateTree(targetId: string, options?: PiRuntimeNavigateTreeOptions): Promise<PiRuntimeNavigateTreeResult>;
	switchSession(sessionPath: string, options?: PiRuntimeSwitchSessionOptions): Promise<PiRuntimeSwitchSessionResult>;
	reload(): Promise<void>;
	extensionError(error: Parameters<NonNullable<PiExtensionBindings["onError"]>>[0]): void;
}

export function createPiExtensionBindings(
	extensionUi: PiExtensionUi,
	modelProjection: PiModelProjection,
	ref: SessionRef,
	runtime: PiAgentSessionRuntime,
	sessionActions: PiExtensionCommandSessionActions,
): PiExtensionBindings {
	const { emitExtensionUiState } = extensionUi.bridge;
	const { isPiExtensionUiContextActive } = extensionUi.capabilities;
	const { createPiExtensionUiContext } = extensionUi;

	const uiContext = createPiExtensionUiContext(ref, {
		getAvailableProviderCount: () =>
			new Set(modelProjection.projectSessionModels(runtime.session).map((model) => model.provider)).size,
		getThemes: () => runtime.session.resourceLoader.getThemes().themes,
	});
	return {
		mode: "rpc",
		uiContext,
		commandContextActions: {
			waitForIdle: () => runtime.session.agent.waitForIdle(),
			async newSession(options) {
				return sessionActions.newSession(options);
			},
			async fork(entryId, options) {
				return sessionActions.fork(entryId, options);
			},
			async navigateTree(targetId, options) {
				return sessionActions.navigateTree(targetId, options);
			},
			async switchSession(sessionPath, options) {
				return sessionActions.switchSession(sessionPath, options);
			},
			async reload() {
				await sessionActions.reload();
			},
		},
		abortHandler: () => {
			void runtime.session.abort().catch((error) => {
				log.error(`extension abort failed for ${ref.sessionId}:`, error);
			});
		},
		shutdownHandler: () => {
			throw createUnsupportedExtensionUiError("ctx.shutdown");
		},
		onError: (error) => {
			if (!isPiExtensionUiContextActive(uiContext)) {
				log.warn(`ignored stale extension error path=${error.extensionPath} event=${error.event}: ${error.error}`);
				return;
			}
			sessionActions.extensionError(error);
			log.error(`extension error path=${error.extensionPath} event=${error.event}: ${error.error}`);
			emitExtensionUiState(ref, {
				type: "notify",
				level: "error",
				message: `Extension error in ${error.extensionPath} (${error.event}): ${error.error}`,
			});
		},
	};
}
