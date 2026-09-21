import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionRefSchema } from "@ling/contracts/session-ref";
import { createSessionRequestSchemas } from "@ling/contracts/session-requests";
import { createProjectFileSchemas } from "@ling/contracts/project-file-requests";
import { createGitRequestSchemas } from "@ling/contracts/git-requests";
import { pathStringSchema } from "@ling/contracts/path-validation";

describe.each([
	{ platform: "POSIX", paths: posix, cwd: "/project" },
	{ platform: "Windows", paths: win32, cwd: "C:\\project" },
])("$platform request boundary", ({ platform, paths, cwd }) => {
	const absolutePath = (label: string, maxLength?: number) =>
		pathStringSchema(label, maxLength).refine(paths.isAbsolute, `${label} must be absolute`);
	const files = createProjectFileSchemas(absolutePath, platform === "Windows");
	const sessions = createSessionRequestSchemas({
		projectPath: absolutePath("Project path"),
		sessionRef: sessionRefSchema.extend({ cwd: absolutePath("Project path") }),
		fileReference: files.projectFileReferenceTargetSchema,
	});
	const git = createGitRequestSchemas(absolutePath, paths.isAbsolute, platform === "Windows");

	it("checks native project and external-reference paths without changing request fields", () => {
		const request = {
			ref: { cwd, sessionId: "session" },
			text: "read",
			mode: "prompt",
			fileReferences: [{ scope: "external", path: cwd + "/file.ts" }],
		};
		expect(sessions.sendMessageRequestSchema.parse(request)).toEqual(request);
		expect(
			sessions.sendMessageRequestSchema.safeParse({ ...request, ref: { ...request.ref, cwd: "relative" } }).success,
		).toBe(false);
		expect(
			sessions.sendMessageRequestSchema.safeParse({
				...request,
				fileReferences: [{ scope: "external", path: "relative" }],
			}).success,
		).toBe(false);
		expect(sessions.createSessionRequestSchema.safeParse({ cwd: "C:relative" }).success).toBe(false);
	});

	it("preserves platform-specific filename semantics and the root-directory exception", () => {
		expect(files.listDirectoryRequestSchema.parse({ cwd, path: "" })).toEqual({ cwd, path: "" });
		expect(files.readFilePreviewRequestSchema.safeParse({ cwd, path: "" }).success).toBe(false);
		expect(files.readFilePreviewRequestSchema.safeParse({ cwd, path: "a\\b" }).success).toBe(platform === "POSIX");
		expect(git.commitFileDiffRequestSchema.safeParse({ cwd, sha: "abcdef0", path: "a\\..\\b" }).success).toBe(
			platform === "POSIX",
		);
		for (const path of ["../file", "/file", "a/../file", "a\0file"]) {
			expect(files.readFilePreviewRequestSchema.safeParse({ cwd, path }).success).toBe(false);
		}
	});
});
