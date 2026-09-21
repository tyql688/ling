import { describe, expect, it } from "vitest";
import { failedFilePreview, type FilePreviewOutcome } from "./use-workspace-file-preview";

describe("workspace file refresh failures", () => {
	const complete: FilePreviewOutcome = {
		cwd: "/project",
		path: "notes.md",
		refreshRevision: "first",
		preview: { kind: "text", path: "notes.md", content: "Read content", revision: "disk", size: 12, modifiedAt: 1 },
		error: null,
	};
	it("retains the last complete document and the new failure together", () => {
		const target = { cwd: complete.cwd, path: complete.path, refreshRevision: "second" };
		const failed = failedFilePreview(complete, target, "File unavailable");
		expect(failed.preview).toBe(complete.preview);
		expect(failed).toMatchObject({ ...target, error: "File unavailable" });
		expect(failedFilePreview(failed, target, "Still unavailable").preview).toBe(complete.preview);
	});
	it("does not present another file or project's successful read as the failed target", () => {
		for (const target of [
			{ cwd: "/project", path: "other.md", refreshRevision: "next" },
			{ cwd: "/another-project", path: "notes.md", refreshRevision: "next" },
		])
			expect(failedFilePreview(complete, target, "Unavailable").preview).toBeNull();
		expect(failedFilePreview(null, complete, "Unavailable").preview).toBeNull();
	});
});
