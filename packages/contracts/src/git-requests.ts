import {
	CHANGE_REVIEW_DIFF_CONTEXT_MAX_LINES,
	CHANGE_REVIEW_DIFF_CONTEXT_MIN_LINES,
	GIT_BRANCH_MAX_CHARS,
	GIT_COMMIT_MESSAGE_MAX_CHARS,
	GIT_COMMIT_SHA_PATTERN,
	GIT_PATH_MAX_CHARS,
	GIT_REVISION_MAX_CHARS,
	GIT_SELECTED_PATHS_MAX_ITEMS,
	GIT_SELECTED_PATHS_TOTAL_MAX_CHARS,
} from "@ling/contracts/git";
import { SESSION_ID_MAX_CHARS } from "@ling/contracts/path-bounds";
import {
	boundedString,
	controlFreeString,
	nonEmptyBoundedString,
	safeIdSchema,
	strictObject,
} from "@ling/contracts/schema-primitives";
import { z } from "zod";
import { operationRefSchema } from "@ling/contracts/owner-ref";

import { portableAbsolutePathSchema, isPortableAbsolutePath } from "./path-validation";
import { sessionRefSchema } from "./session-ref";
/** Native hosts supply their path rules here; all request fields keep one definition. */
export function createGitRequestSchemas(
	absolutePathSchema = portableAbsolutePathSchema,
	isAbsolute = isPortableAbsolutePath,
	windowsPaths = false,
) {
	const projectPathSchema = absolutePathSchema("Project path");
	/** snapshotId field cap; short hash/UUID magnitude — longer is treated as a forged reference. */
	const MAX_SNAPSHOT_ID_LENGTH = 128;
	/** turnId field cap: same short-id boundary as sessionId. */
	const MAX_TURN_ID_LENGTH = SESSION_ID_MAX_CHARS;

	const gitRelativePathSchema = nonEmptyBoundedString(GIT_PATH_MAX_CHARS, "Git path")
		.refine((value) => !value.includes("\0"), "Git path must not contain NUL")
		.refine((value) => !isAbsolute(value), "Git path must be relative")
		.refine(
			(value) => !(windowsPaths ? value.split(/[/\\]/) : value.split("/")).includes(".."),
			"Git path must not escape the project",
		);

	const branchSchema = controlFreeString(GIT_BRANCH_MAX_CHARS, "Branch")
		.transform((value) => value.trim())
		.refine((value) => !value.startsWith("-"), "Branch must not be option-like");

	const revisionSchema = controlFreeString(GIT_REVISION_MAX_CHARS, "Worktree start point")
		.transform((value) => value.trim())
		.refine((value) => !value.startsWith("-"), "Worktree start point must not be option-like");

	const commitMessageSchema = boundedString(GIT_COMMIT_MESSAGE_MAX_CHARS, "Commit message")
		.refine((value) => value.trim().length > 0, "Commit message must not be empty")
		.refine((value) => !value.includes("\0"), "Commit message must not contain NUL");

	const changeReviewRefSchema = strictObject({ ...sessionRefSchema.shape, cwd: projectPathSchema });

	const changeReviewScopeSchema = z.enum([
		"turn",
		"session",
		"workspace",
		"unpushed",
		"preexisting",
		"external",
		"mixed",
		"committed",
	]);
	const writableChangeReviewScopeSchema = z.enum(["turn", "session", "workspace", "preexisting"]);

	const changePathsSchema = z
		.array(gitRelativePathSchema)
		.max(GIT_SELECTED_PATHS_MAX_ITEMS, `At most ${GIT_SELECTED_PATHS_MAX_ITEMS} change paths may be selected`)
		.superRefine((paths, context) => {
			if (paths.reduce((total, path) => total + path.length, 0) > GIT_SELECTED_PATHS_TOTAL_MAX_CHARS) {
				context.addIssue({ code: "custom", message: "Selected change paths are too large" });
			}
		})
		.transform((paths) => [...new Set(paths)]);

	const changeReviewRefRequestSchema = changeReviewRefSchema;

	const changeReviewDiffRequestSchema = strictObject({
		operation: operationRefSchema,
		ref: changeReviewRefSchema,
		snapshotId: safeIdSchema(MAX_SNAPSHOT_ID_LENGTH, "Change snapshot id"),
		deadlineAt: z.number().int().positive(),
		scope: changeReviewScopeSchema,
		path: gitRelativePathSchema,
		contextLines: z
			.number()
			.int()
			.min(CHANGE_REVIEW_DIFF_CONTEXT_MIN_LINES)
			.max(CHANGE_REVIEW_DIFF_CONTEXT_MAX_LINES)
			.optional(),
		turnId: safeIdSchema(MAX_TURN_ID_LENGTH, "Turn id").optional(),
	}).superRefine((request, context) => {
		if (request.scope !== "turn" && request.turnId !== undefined) {
			context.addIssue({ code: "custom", path: ["turnId"], message: "turnId is valid only for turn scope" });
		}
		if (request.scope === "turn" && request.contextLines !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["contextLines"],
				message: "contextLines is unavailable for immutable turn snapshots",
			});
		}
	});

	const revertChangeReviewTurnRequestSchema = strictObject({
		ref: changeReviewRefSchema,
		turnId: safeIdSchema(MAX_TURN_ID_LENGTH, "Turn id"),
	});

	const cancelChangeReviewDiffRequestSchema = strictObject({
		operation: operationRefSchema,
		ref: changeReviewRefSchema,
		snapshotId: safeIdSchema(MAX_SNAPSHOT_ID_LENGTH, "Change snapshot id"),
	});

	const commitChangeReviewRequestSchema = strictObject({
		ref: changeReviewRefSchema,
		snapshotId: safeIdSchema(MAX_SNAPSHOT_ID_LENGTH, "Change snapshot id"),
		scope: writableChangeReviewScopeSchema,
		paths: changePathsSchema,
		message: commitMessageSchema,
	});

	const discardChangeReviewRequestSchema = strictObject({
		ref: changeReviewRefSchema,
		snapshotId: safeIdSchema(MAX_SNAPSHOT_ID_LENGTH, "Change snapshot id"),
		scope: writableChangeReviewScopeSchema,
		paths: changePathsSchema,
	});

	const commitShaSchema = z.string().regex(GIT_COMMIT_SHA_PATTERN, "Commit id must be lowercase hexadecimal");

	const commitChangedFilesRequestSchema = strictObject({
		cwd: projectPathSchema,
		sha: commitShaSchema,
	});

	const commitFileDiffRequestSchema = strictObject({
		cwd: projectPathSchema,
		sha: commitShaSchema,
		path: gitRelativePathSchema,
	});

	const switchBranchRequestSchema = strictObject({
		cwd: projectPathSchema,
		branch: branchSchema,
	});

	const createBranchRequestSchema = strictObject({
		cwd: projectPathSchema,
		branch: branchSchema,
		checkout: z.boolean(),
	});

	const commitAllRequestSchema = strictObject({
		cwd: projectPathSchema,
		message: commitMessageSchema,
	});

	const pushBranchRequestSchema = strictObject({ cwd: projectPathSchema });

	const createWorktreeRequestSchema = strictObject({
		rootCwd: projectPathSchema,
		path: absolutePathSchema("Worktree path", GIT_PATH_MAX_CHARS),
		branchName: branchSchema.optional(),
		startPoint: revisionSchema.optional(),
	});

	const removeWorktreeRequestSchema = strictObject({
		rootCwd: projectPathSchema,
		worktreePath: absolutePathSchema("Worktree path", GIT_PATH_MAX_CHARS),
	});

	return {
		changeReviewRefRequestSchema,
		changeReviewDiffRequestSchema,
		revertChangeReviewTurnRequestSchema,
		cancelChangeReviewDiffRequestSchema,
		commitChangeReviewRequestSchema,
		discardChangeReviewRequestSchema,
		commitChangedFilesRequestSchema,
		commitFileDiffRequestSchema,
		switchBranchRequestSchema,
		createBranchRequestSchema,
		commitAllRequestSchema,
		pushBranchRequestSchema,
		createWorktreeRequestSchema,
		removeWorktreeRequestSchema,
	};
}
