import type { ProjectDroppedFileReferenceResult } from "@ling/contracts/project";
import { projectProcedures } from "@ling/contracts/project-procedures";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";

import {
	browseHostDirectories,
	listProjectDirectory,
	readProjectFilePreview,
	resolveDroppedFileReferences,
	resolveExistingProjectPath,
	resolveProjectFileReferencePath,
	createProjectFileWriter,
} from "@ling/host/domains/files/project-files";
import type { ProjectAccess } from "@ling/host/runtime/project-access";

export function createProjectFileDomain({
	projectOperations,
	projectsRestored,
}: {
	projectOperations: ProjectAccess;
	projectsRestored: Promise<void>;
}): HostDomain {
	const { withKnownOpenProject } = projectOperations;
	const writeProjectFile = createProjectFileWriter();

	const handlers: HostHandlers = {
		[projectProcedures.browseDirectories.channel]: async (_event, path) => browseHostDirectories(path),

		[projectProcedures.listDirectory.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => listProjectDirectory(cwd, value.path));
		},

		[projectProcedures.readFilePreview.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => readProjectFilePreview(cwd, value.path));
		},

		[projectProcedures.writeFile.channel]: async (_event, value) => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) =>
				writeProjectFile(cwd, value.path, value.content, value.expectedRevision),
			);
		},

		[projectProcedures.resolveDroppedFileReferences.channel]: async (
			_event,
			value,
		): Promise<ProjectDroppedFileReferenceResult[]> => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => resolveDroppedFileReferences(cwd, value.filePaths));
		},

		[projectProcedures.revealFileReference.channel]: async (_event, value): Promise<string> => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => resolveProjectFileReferencePath(cwd, value.reference));
		},

		[projectProcedures.revealEntry.channel]: async (_event, value): Promise<string> => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => resolveExistingProjectPath(cwd, value.path));
		},
	};
	return { handlers };
}
