import {
	PROJECT_RELATIVE_PATH_MAX_CHARS,
	PROJECT_FILE_REFERENCE_MAX_ITEMS,
	PROJECT_TEXT_PREVIEW_MAX_BYTES,
} from "./project";
import { boundedString, strictObject } from "./schema-primitives";
import { portableAbsolutePathSchema } from "./path-validation";
import { z } from "zod";
/** Native hosts supply their path rules here; all request fields keep one definition. */
export function createProjectFileSchemas(absolutePathSchema = portableAbsolutePathSchema, windowsPaths = false) {
	const projectPathSchema = absolutePathSchema("Project path");
	const projectFileReferencePathSchema = boundedString(PROJECT_RELATIVE_PATH_MAX_CHARS, "Project file path")
		.refine((value) => value.length > 0, "Project file path must not be empty")
		.refine((value) => !value.includes("\0"), "Project file path must not contain NUL")
		.refine((value) => !windowsPaths || !value.includes("\\"), "Project file path must use forward slashes")
		.refine(
			(value) =>
				!value.startsWith("/") &&
				!value.endsWith("/") &&
				value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
			"Project file path must stay inside the project",
		);

	const projectFileReferenceLineRangeSchema = z
		.strictObject({
			start: z.number().int().min(1).max(1_000_000),
			end: z.number().int().min(1).max(1_000_000),
		})
		.refine((range) => range.end >= range.start, "Line range end must not precede its start");

	const projectFileReferenceTargetSchema = z.discriminatedUnion("scope", [
		z.strictObject({
			scope: z.literal("project"),
			path: projectFileReferencePathSchema,
			lineRange: projectFileReferenceLineRangeSchema.optional(),
		}),
		z.strictObject({ scope: z.literal("external"), path: absolutePathSchema("External file path") }),
	]);

	const projectRelativePathSchema = boundedString(PROJECT_RELATIVE_PATH_MAX_CHARS, "Project-relative path")
		.refine((value) => !value.includes("\0"), "Project-relative path must not contain NUL")
		.refine((value) => !windowsPaths || !value.includes("\\"), "Project-relative path must use forward slashes")
		.refine(
			(value) =>
				value === "" ||
				(!value.startsWith("/") &&
					!value.endsWith("/") &&
					value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")),
			"Project-relative path must stay inside the project",
		);

	const listDirectoryRequestSchema = strictObject({
		cwd: projectPathSchema,
		path: projectRelativePathSchema,
	});

	const readFilePreviewRequestSchema = strictObject({
		cwd: projectPathSchema,
		path: projectFileReferencePathSchema,
	});

	const writeFileRequestSchema = strictObject({
		cwd: projectPathSchema,
		path: projectFileReferencePathSchema,
		content: z.string().max(PROJECT_TEXT_PREVIEW_MAX_BYTES),
		expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
	});

	const resolveDroppedFileReferencesRequestSchema = strictObject({
		cwd: projectPathSchema,
		filePaths: projectPathSchema.array().max(PROJECT_FILE_REFERENCE_MAX_ITEMS),
	});

	const revealFileReferenceRequestSchema = z.strictObject({
		cwd: projectPathSchema,
		reference: projectFileReferenceTargetSchema,
	});

	const revealEntryRequestSchema = strictObject({
		cwd: projectPathSchema,
		path: projectFileReferencePathSchema,
	});

	return {
		projectFileReferencePathSchema,
		projectFileReferenceTargetSchema,
		listDirectoryRequestSchema,
		readFilePreviewRequestSchema,
		writeFileRequestSchema,
		resolveDroppedFileReferencesRequestSchema,
		revealFileReferenceRequestSchema,
		revealEntryRequestSchema,
	};
}
