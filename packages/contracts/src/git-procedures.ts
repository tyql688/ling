import { argumentsOf, request, returns } from "./procedure";
import type {
	CommitAllRequest,
	CommitChangedFilesRequest,
	CommitFileDiffRequest,
	CreateBranchRequest,
	CreateWorktreeRequest,
	GitChangedFile,
	GitCommitResult,
	GitGraph,
	GitStatus,
	PushBranchRequest,
	RemoveWorktreeRequest,
	SwitchBranchRequest,
	WorktreeBranchOption,
} from "./git";
import { createGitRequestSchemas } from "./git-requests";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
import type { OpenProjectInfo, ProjectRemovalOutcome } from "./project";
export function createGitProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const schemas = {
		...createGitRequestSchemas(paths.absolute, paths.isAbsolute, paths.windows),
		projectPathSchema: paths.absolute("Project path"),
	};
	return {
		getStatus: request(
			"git:getStatus",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<GitStatus>(),
		),
		getChangedFiles: request(
			"git:getChangedFiles",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<GitChangedFile[]>(),
		),
		getGraph: request(
			"git:getGraph",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<GitGraph>(),
		),
		getCommitChangedFiles: request(
			"git:getCommitChangedFiles",
			argumentsOf<[request: CommitChangedFilesRequest]>((args) => [
				schemas.commitChangedFilesRequestSchema.parse(args[0]),
			]),
			returns<GitChangedFile[]>(),
		),
		getCommitFileDiff: request(
			"git:getCommitFileDiff",
			argumentsOf<[request: CommitFileDiffRequest]>((args) => [schemas.commitFileDiffRequestSchema.parse(args[0])]),
			returns<string>(),
		),
		switchBranch: request(
			"git:switchBranch",
			argumentsOf<[request: SwitchBranchRequest]>((args) => [schemas.switchBranchRequestSchema.parse(args[0])]),
			returns<GitStatus>(),
		),
		createBranch: request(
			"git:createBranch",
			argumentsOf<[request: CreateBranchRequest]>((args) => [schemas.createBranchRequestSchema.parse(args[0])]),
			returns<GitStatus>(),
		),
		commitAll: request(
			"git:commitAll",
			argumentsOf<[request: CommitAllRequest]>((args) => [schemas.commitAllRequestSchema.parse(args[0])]),
			returns<GitCommitResult>(),
		),
		push: request(
			"git:push",
			argumentsOf<[request: PushBranchRequest]>((args) => [schemas.pushBranchRequestSchema.parse(args[0])]),
			returns<GitStatus>(),
		),
		generateCommitMessage: request(
			"git:generateCommitMessage",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<string>(),
		),
		listWorktreeBranches: request(
			"git:listWorktreeBranches",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<WorktreeBranchOption[]>(),
		),
		createWorktree: request(
			"git:createWorktree",
			argumentsOf<[request: CreateWorktreeRequest]>((args) => [schemas.createWorktreeRequestSchema.parse(args[0])]),
			returns<OpenProjectInfo>(),
		),
		removeWorktree: request(
			"git:removeWorktree",
			argumentsOf<[request: RemoveWorktreeRequest]>((args) => [schemas.removeWorktreeRequestSchema.parse(args[0])]),
			returns<ProjectRemovalOutcome>(),
		),
	};
}
export const gitProcedures = createGitProcedures();
