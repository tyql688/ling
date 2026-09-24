import { dataStoreProcedures } from "../data-store-procedures";
import { diagnosticsProcedures } from "../diagnostics-procedures";
import { userStateProcedures } from "../user-state-procedures";
import { draftProcedures } from "../draft-procedures";
import { agentProcedures } from "../agent-procedures";
import { appProcedures } from "../application-procedures";
import { changeReviewProcedures, createChangeReviewProcedures } from "../change-review-procedures";
import { createGitProcedures, gitProcedures } from "../git-procedures";
import { globalInstructionsProcedures } from "../global-instructions-procedures";
import { modelsProcedures } from "../model-procedures";
import { networkProcedures } from "../network-procedures";
import { createPiSettingsProcedures, piSettingsProcedures } from "../pi-settings-procedures";
import { createPluginsProcedures, pluginsProcedures } from "../plugin-procedures";
import { interactionProcedures } from "../interaction-procedures";
import { todoProcedures } from "../todo-procedures";
import { permissionsProcedures } from "../permissions-procedures";
import { builtinFeaturesProcedures } from "../builtin-feature-procedures";
import { mcpProcedures } from "../mcp-procedures";
import { voiceProcedures } from "../voice-procedures";
import { questionsProcedures } from "../questions-procedures";
import { backgroundTasksProcedures } from "../background-tasks-procedures";
import { schedulesProcedures } from "../schedules-procedures";
import type { ProcedurePaths } from "../procedure-paths";
import { createProjectProcedures, projectProcedures } from "../project-procedures";
import { createSessionProcedures, sessionProcedures } from "../session-procedures";
import { skillsProcedures } from "../skill-procedures";
import { skinsProcedures } from "../skin-procedures";
import { createTerminalProcedures, terminalProcedures } from "../terminal-procedures";
import { usageProcedures } from "../usage-procedures";
import { editorLanguageProcedures } from "../editor-language-procedures";
import {
	createProcedureClient,
	type ProcedureClient,
	type ProcedureTransport,
	type RequestProcedure,
} from "../procedure";
export function createHostProcedures(paths?: ProcedurePaths) {
	return {
		editorLanguage: editorLanguageProcedures,
		draft: draftProcedures,
		userState: userStateProcedures,
		data: dataStoreProcedures,
		diagnostics: diagnosticsProcedures,
		app: appProcedures,
		changeReview: paths ? createChangeReviewProcedures(paths) : changeReviewProcedures,
		git: paths ? createGitProcedures(paths) : gitProcedures,
		agent: agentProcedures,
		usage: usageProcedures,
		project: paths ? createProjectProcedures(paths) : projectProcedures,
		terminal: paths ? createTerminalProcedures(paths) : terminalProcedures,
		plugins: paths ? createPluginsProcedures(paths) : pluginsProcedures,
		interactions: interactionProcedures,
		todo: todoProcedures,
		permissions: permissionsProcedures,
		builtinFeatures: builtinFeaturesProcedures,
		voice: voiceProcedures,
		mcp: mcpProcedures,
		questions: questionsProcedures,
		backgroundTasks: backgroundTasksProcedures,
		schedules: schedulesProcedures,
		skills: skillsProcedures,
		skins: skinsProcedures,
		network: networkProcedures,
		piSettings: paths ? createPiSettingsProcedures(paths) : piSettingsProcedures,
		globalInstructions: globalInstructionsProcedures,
		models: modelsProcedures,
		session: paths ? createSessionProcedures(paths) : sessionProcedures,
	};
}
const hostProcedures = createHostProcedures();
type HostProcedures = typeof hostProcedures;
export type HostApi = { [Domain in keyof HostProcedures]: ProcedureClient<HostProcedures[Domain]> };
export type HostRequest = Extract<
	{ [Domain in keyof HostProcedures]: HostProcedures[Domain][keyof HostProcedures[Domain]] }[keyof HostProcedures],
	RequestProcedure
>;
export function createHostClient(transport: ProcedureTransport): HostApi {
	return Object.fromEntries(
		Object.entries(hostProcedures).map(([domain, procedures]) => [
			domain,
			createProcedureClient(procedures, transport),
		]),
	) as HostApi;
}
