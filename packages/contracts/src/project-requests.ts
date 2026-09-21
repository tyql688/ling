import { PROJECT_LAUNCH_TARGET_IDS } from "./project";
import { portableAbsolutePathSchema } from "./path-validation";
import { strictObject } from "./schema-primitives";
import { z } from "zod";
/** Native hosts supply their path rules here; all request fields keep one definition. */
export function createProjectRequestSchemas(projectPathSchema = portableAbsolutePathSchema("Project path")) {
	const listProjectFilesRequestSchema = z.strictObject({
		cwd: projectPathSchema,
		query: z.string().max(1_024),
	});

	const projectLaunchRequestSchema = strictObject({
		cwd: projectPathSchema,
		targetId: z.enum(PROJECT_LAUNCH_TARGET_IDS),
	});

	const projectLaunchDefaultRequestSchema = strictObject({
		cwd: projectPathSchema,
		kind: z.enum(["file-manager", "editor", "terminal"]),
	});

	const emptyProjectStoreRequestSchema = z.undefined();

	return {
		listProjectFilesRequestSchema,
		projectLaunchRequestSchema,
		projectLaunchDefaultRequestSchema,
		emptyProjectStoreRequestSchema,
	};
}
