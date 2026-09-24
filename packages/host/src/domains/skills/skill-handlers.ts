import type { PiResourceReloadSummary } from "@ling/contracts/session";
import type {
	SkillPathMutationResponse,
	SkillToggleMutationResponse,
	SkillUpdateRunResult,
} from "@ling/contracts/skill";
import { skillsProcedures } from "@ling/contracts/skill-procedures";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";

import { checkGlobalSkillUpdates } from "@ling/host/domains/skills/skill-update-check";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import { piResourceReloadError, type ResourceReloadCoordinator } from "@ling/host/domains/resources/resource-reload";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { planGlobalSkillUpdates, runGlobalSkillsUpdate } from "./skill-update-runner";

export function createSkillDomain({
	piWorker,
	resources,
	projectOperations,
	projectsRestored,
}: {
	piWorker: PiWorkerClient;
	resources: ResourceReloadCoordinator;
	projectOperations: ProjectAccess;
	projectsRestored: Promise<void>;
}): HostDomain {
	const { reloadPiResources, mutateThenReloadPiResources } = resources;
	const { withKnownOpenProject } = projectOperations;

	/** Renderer-supplied paths are only honored when Pi actually loaded them as skills. */
	async function assertLoadedSkillPath(filePath: string): Promise<void> {
		const overview = await piWorker.readSkillsOverview();
		if (!overview.skills.some((skill) => skill.filePath === filePath)) {
			throw new Error("Unknown skill file path");
		}
	}

	async function mutateSkillPath(path: string, mutate: () => Promise<void>): Promise<SkillPathMutationResponse> {
		const bothFailedMessage = "Skill path mutation and Pi resource reconciliation both failed";
		const { mutation, reload } = await mutateThenReloadPiResources(bothFailedMessage, mutate);
		if (mutation.failed) {
			const reloadError = piResourceReloadError(
				reload,
				"The skill path mutation failed, and one or more live Pi resources could not reload.",
			);
			if (reloadError) throw new AggregateError([mutation.error, reloadError], bothFailedMessage);
			throw mutation.error;
		}
		// Incomplete-summary details surface through the renderer's reload notice instead.
		return { path, reload };
	}

	/** Skill switches persist to Pi's global settings.json; disabled skills are not
	 * loaded, so the mutation must reconcile live Pi resources like path mutations. */
	async function mutateSkillToggle(mutate: () => Promise<boolean>): Promise<SkillToggleMutationResponse> {
		const bothFailedMessage = "Skill toggle and Pi resource reconciliation both failed";
		const { mutation, reload } = await mutateThenReloadPiResources(
			bothFailedMessage,
			async () => ((await mutate()) ? undefined : []),
			{ mode: "configuration" },
		);
		if (mutation.failed) {
			const reloadError = piResourceReloadError(
				reload,
				"The skill toggle failed, and one or more live Pi resources could not reload.",
			);
			if (reloadError) throw new AggregateError([mutation.error, reloadError], bothFailedMessage);
			throw mutation.error;
		}
		return { reload };
	}

	const handlers: HostHandlers = {
		[skillsProcedures.overview.channel]: async () => {
			await projectsRestored;
			return piWorker.readSkillsOverview();
		},

		[skillsProcedures.reload.channel]: async (): Promise<PiResourceReloadSummary> => {
			await projectsRestored;
			return reloadPiResources();
		},

		[skillsProcedures.projectSkills.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => piWorker.readProjectSkills(cwd));
		},

		[skillsProcedures.reveal.channel]: async (_event, value): Promise<string> => {
			await projectsRestored;
			await assertLoadedSkillPath(value.filePath);
			return value.filePath;
		},

		[skillsProcedures.readContent.channel]: async (_event, value) => {
			await projectsRestored;
			await assertLoadedSkillPath(value.filePath);
			return piWorker.readSkillContent(value.filePath);
		},

		[skillsProcedures.listResources.channel]: async (_event, value) => {
			await projectsRestored;
			await assertLoadedSkillPath(value.filePath);
			return piWorker.listSkillResources(value.filePath);
		},

		[skillsProcedures.readResource.channel]: async (_event, value) => {
			await projectsRestored;
			await assertLoadedSkillPath(value.filePath);
			return piWorker.readSkillResource(value.filePath, value.relativePath);
		},

		[skillsProcedures.revealResource.channel]: async (_event, value): Promise<string> => {
			await projectsRestored;
			await assertLoadedSkillPath(value.filePath);
			return piWorker.resolveSkillResourcePath(value.filePath, value.relativePath);
		},

		[skillsProcedures.openGlobalDir.channel]: async (): Promise<{ dir: string }> => {
			const { agentDir } = await piWorker.getAgentInfo();
			const dir = join(agentDir, "skills");
			await mkdir(dir, { recursive: true });
			return { dir };
		},

		[skillsProcedures.addPath.channel]: async (_event, value): Promise<SkillPathMutationResponse> => {
			await projectsRestored;
			const { path } = { path: value };
			return mutateSkillPath(path, () => piWorker.addGlobalSkillPath(path));
		},

		[skillsProcedures.removePath.channel]: async (_event, value) => {
			await projectsRestored;
			return mutateSkillPath(value.path, () => piWorker.removeGlobalSkillPath(value.path));
		},

		[skillsProcedures.setBuiltinEnabled.channel]: async (_event, value) => {
			await projectsRestored;
			return mutateSkillToggle(() => piWorker.setBuiltinSkillsEnabled(value.enabled));
		},

		[skillsProcedures.setSkillEnabled.channel]: async (_event, value) => {
			await projectsRestored;
			return mutateSkillToggle(() => piWorker.setSkillEnabled(value.name, value.enabled));
		},

		[skillsProcedures.checkUpdates.channel]: async () => {
			await projectsRestored;
			const { agentDir } = await piWorker.getAgentInfo();
			return checkGlobalSkillUpdates(join(agentDir, "skills"));
		},

		[skillsProcedures.runUpdates.channel]: async (_event, value): Promise<SkillUpdateRunResult> => {
			await projectsRestored;
			const { agentDir } = await piWorker.getAgentInfo();
			const plans = await planGlobalSkillUpdates(value.names, join(agentDir, "skills"));
			const output = await runGlobalSkillsUpdate(plans);
			// The CLI rewrote skill folders on disk; live Pi resources must pick them up.
			return { output, reload: await reloadPiResources() };
		},
	};
	return { handlers };
}
