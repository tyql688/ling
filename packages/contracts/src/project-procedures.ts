import { z } from "zod";
import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
import type {
	HostDirectoryListing,
	OpenProjectInfo,
	ProjectDirectoryListing,
	ProjectDroppedFileReferenceResult,
	ProjectFilePreview,
	ProjectLaunchDefaultRequest,
	ProjectLaunchRequest,
	ProjectLaunchTarget,
	ProjectListDirectoryRequest,
	ProjectListResult,
	ProjectMentionItem,
	ProjectPiConfig,
	ProjectReadFilePreviewRequest,
	ProjectRemovalOutcome,
	ProjectRevealEntryRequest,
	ProjectRevealFileReferenceRequest,
	ProjectStoreStatus,
	ProjectTrustChoice,
	ProjectTrustRequest,
	ProjectWriteFileRequest,
	ProjectWriteFileResult,
} from "./project";
import { createProjectFileSchemas } from "./project-file-requests";
import { createProjectRequestSchemas } from "./project-requests";
import type { DialogDismissEvent } from "./session";
import { dialogRequestIdSchema } from "./session-shell-validation";
export function createProjectProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const schemas = {
		...createProjectRequestSchemas(paths.absolute("Project path")),
		...createProjectFileSchemas(paths.absolute, paths.windows),
		projectPathSchema: paths.absolute("Project path"),
		trustResponseSchema: z.strictObject({
			requestId: dialogRequestIdSchema,
			choice: z.enum(["trust", "session", "deny"]).nullable(),
		}),
	};
	return {
		list: request("project:list", noArguments, returns<ProjectListResult>()),
		onChanged: event("project:changed", returns<null>()),
		storeStatus: request(
			"project:storeStatus",
			argumentsOf<[]>((args) => {
				schemas.emptyProjectStoreRequestSchema.parse(args[0]);
				return [];
			}),
			returns<ProjectStoreStatus>(),
		),
		retryStore: request(
			"project:retryStore",
			argumentsOf<[]>((args) => {
				schemas.emptyProjectStoreRequestSchema.parse(args[0]);
				return [];
			}),
			returns<void>(),
		),
		resetStore: request(
			"project:resetStore",
			argumentsOf<[]>((args) => {
				schemas.emptyProjectStoreRequestSchema.parse(args[0]);
				return [];
			}),
			returns<void>(),
		),
		add: request(
			"project:add",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<OpenProjectInfo>(),
		),
		browseDirectories: request(
			"project:browseDirectories",
			argumentsOf<[path: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<HostDirectoryListing>(),
		),
		remove: request(
			"project:remove",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<ProjectRemovalOutcome>(),
		),
		listFiles: request(
			"project:listFiles",
			argumentsOf<[request: { cwd: string; query: string }]>((args) => [
				schemas.listProjectFilesRequestSchema.parse(args[0]),
			]),
			returns<ProjectMentionItem[]>(),
		),
		listDirectory: request(
			"project:listDirectory",
			argumentsOf<[request: ProjectListDirectoryRequest]>((args) => [
				schemas.listDirectoryRequestSchema.parse(args[0]),
			]),
			returns<ProjectDirectoryListing>(),
		),
		readFilePreview: request(
			"project:readFilePreview",
			argumentsOf<[request: ProjectReadFilePreviewRequest]>((args) => [
				schemas.readFilePreviewRequestSchema.parse(args[0]),
			]),
			returns<ProjectFilePreview>(),
		),
		writeFile: request(
			"project:writeFile",
			argumentsOf<[request: ProjectWriteFileRequest]>((args) => [schemas.writeFileRequestSchema.parse(args[0])]),
			returns<ProjectWriteFileResult>(),
		),
		resolveDroppedFileReferences: request(
			"project:resolveDroppedFileReferences",
			argumentsOf<[request: { cwd: string; filePaths: string[] }]>((args) => [
				schemas.resolveDroppedFileReferencesRequestSchema.parse(args[0]),
			]),
			returns<ProjectDroppedFileReferenceResult[]>(),
		),
		revealFileReference: request(
			"project:revealFileReference",
			argumentsOf<[request: ProjectRevealFileReferenceRequest]>((args) => [
				schemas.revealFileReferenceRequestSchema.parse(args[0]),
			]),
			returns<string>(),
		),
		revealEntry: request(
			"project:revealEntry",
			argumentsOf<[request: ProjectRevealEntryRequest]>((args) => [schemas.revealEntryRequestSchema.parse(args[0])]),
			returns<string>(),
		),
		piConfig: request(
			"project:piConfig",
			argumentsOf<[cwd: string]>((args) => [schemas.projectPathSchema.parse(args[0])]),
			returns<ProjectPiConfig>(),
		),
		listLaunchTargets: request(
			"project:listLaunchTargets",
			argumentsOf<[]>((args) => {
				schemas.emptyProjectStoreRequestSchema.parse(args[0]);
				return [];
			}),
			returns<ProjectLaunchTarget[]>(),
		),
		launch: request(
			"project:launch",
			argumentsOf<[request: ProjectLaunchRequest]>((args) => [schemas.projectLaunchRequestSchema.parse(args[0])]),
			returns<void>(),
		),
		launchDefault: request(
			"project:launchDefault",
			argumentsOf<[request: ProjectLaunchDefaultRequest]>((args) => [
				schemas.projectLaunchDefaultRequestSchema.parse(args[0]),
			]),
			returns<void>(),
		),
		pendingTrustRequests: request("project:trust:pending", noArguments, returns<ProjectTrustRequest[]>()),
		respondTrust: request(
			"project:trust:respond",
			argumentsOf<[requestId: string, choice: ProjectTrustChoice | null]>((args) => {
				const parsed = schemas.trustResponseSchema.parse({ requestId: args[0], choice: args[1] });
				return [parsed.requestId, parsed.choice];
			}),
			returns<void>(),
		),
		onTrustRequest: event("project:trust-request", returns<ProjectTrustRequest>()),
		onTrustDismiss: event("project:trust-dismiss", returns<DialogDismissEvent>()),
	};
}
export const projectProcedures = createProjectProcedures();
