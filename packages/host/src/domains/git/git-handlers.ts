import { gitProcedures } from "@ling/contracts/git-procedures";
import {
	commitAll,
	createBranch,
	createWorktree,
	destroyCreatedWorktree,
	generateCommitMessage,
	listWorktreeBranchOptions,
	pushCurrentBranch,
	switchBranch,
} from "@ling/host/domains/git/git-mutations";
import {
	getChangedFiles,
	getCommitChangedFiles,
	getCommitFileDiff,
	getGitGraph,
	getGitStatus,
} from "@ling/host/domains/git/git-service";
import { createLogger } from "@ling/core/logger";
import type { GitWriteQueue } from "@ling/host/domains/git/git-write-queue";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import type { OpenProjectInfo, ProjectRemovalOutcome } from "@ling/contracts/project";

const log = createLogger("git-ipc");

export function createGitDomain({
	projectOperations,
	gitWrites,
	projectsRestored,
	projects,
	afterProjectRuntimeClose,
}: {
	projectOperations: ProjectAccess;
	gitWrites: GitWriteQueue;
	projectsRestored: Promise<void>;
	projects: {
		recovery: { assertWritable(): void };
		openProjectAndPersist(path: string): Promise<OpenProjectInfo>;
		removeWorktreeProjectAndPersist(
			rootCwd: string,
			worktreePath: string,
			options: { afterRuntimeClose?: (project: { cwd: string }) => Promise<void> | void },
		): Promise<ProjectRemovalOutcome>;
	};
	afterProjectRuntimeClose?: (project: { cwd: string }) => Promise<void> | void;
}): HostDomain {
	const { withKnownOpenProject } = projectOperations;
	const { runBoundedGitWriteForWorkspace } = gitWrites;

	const write = <Result>(cwd: string, operation: (canonicalCwd: string, signal: AbortSignal) => Promise<Result>) =>
		withKnownOpenProject(cwd, (canonicalCwd) =>
			runBoundedGitWriteForWorkspace(canonicalCwd, (signal) => operation(canonicalCwd, signal)),
		);

	const handlers: HostHandlers = {
		[gitProcedures.getStatus.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value, getGitStatus);
		},

		[gitProcedures.getChangedFiles.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value, getChangedFiles);
		},

		[gitProcedures.getGraph.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value, getGitGraph);
		},

		[gitProcedures.getCommitChangedFiles.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => getCommitChangedFiles(cwd, value.sha));
		},

		[gitProcedures.getCommitFileDiff.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => getCommitFileDiff(cwd, value.sha, value.path));
		},

		[gitProcedures.switchBranch.channel]: async (_event, value) => {
			await projectsRestored;
			return write(value.cwd, (cwd, signal) => switchBranch(cwd, value.branch, signal));
		},

		[gitProcedures.createBranch.channel]: async (_event, value) => {
			await projectsRestored;
			return write(value.cwd, (cwd, signal) => createBranch({ ...value, cwd }, signal));
		},

		[gitProcedures.commitAll.channel]: async (_event, value) => {
			await projectsRestored;
			return write(value.cwd, (cwd, signal) => commitAll(cwd, value.message, signal));
		},

		[gitProcedures.push.channel]: async (_event, value) => {
			await projectsRestored;
			return write(value.cwd, pushCurrentBranch);
		},

		[gitProcedures.generateCommitMessage.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value, generateCommitMessage);
		},

		[gitProcedures.listWorktreeBranches.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value, listWorktreeBranchOptions);
		},

		[gitProcedures.createWorktree.channel]: async (_event, value) => {
			await projectsRestored;
			projects.recovery.assertWritable();
			const created = await write(value.rootCwd, (cwd, signal) =>
				createWorktree(
					cwd,
					{
						path: value.path,
						...(value.branchName ? { branchName: value.branchName } : {}),
						...(value.startPoint ? { startPoint: value.startPoint } : {}),
					},
					signal,
				),
			);
			try {
				return await projects.openProjectAndPersist(created.canonicalPath);
			} catch (error) {
				// Worktree creation is a transaction: if the project half fails, the just-created
				// worktree (and branch) must not survive as an orphan the user never asked for.
				try {
					const failures = await write(value.rootCwd, (cwd, signal) =>
						destroyCreatedWorktree(
							cwd,
							{ path: created.canonicalPath, ...(value.branchName ? { branchName: value.branchName } : {}) },
							signal,
						),
					);
					for (const failure of failures) log.error(`worktree rollback left an artifact — ${failure}`);
				} catch (rollbackError) {
					log.error("worktree rollback failed:", rollbackError);
				}
				throw error;
			}
		},

		[gitProcedures.removeWorktree.channel]: async (_event, value) => {
			await projectsRestored;
			// Project removal owns the stricter transaction queue; acquiring a Git lease
			// here would invert the lock order.
			return projects.removeWorktreeProjectAndPersist(value.rootCwd, value.worktreePath, {
				...(afterProjectRuntimeClose ? { afterRuntimeClose: afterProjectRuntimeClose } : {}),
			});
		},
	};
	return { handlers };
}
