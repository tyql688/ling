import { describe, expect, it } from "vitest";
import { createBuiltinOperationRef, CHANGE_REVIEW_DIFF_OWNER_ID } from "./owner-ref";
import { createGitRequestSchemas } from "./git-requests";

const schemas = createGitRequestSchemas();

describe("Git request normalization", () => {
	it("trims branch names and deduplicates selections without changing their order", () => {
		expect(
			schemas.createBranchRequestSchema.parse({ cwd: "/project", branch: "  feature  ", checkout: false }),
		).toEqual({ cwd: "/project", branch: "feature", checkout: false });
		expect(
			schemas.createBranchRequestSchema.safeParse({ cwd: "/project", branch: " --help ", checkout: true }).success,
		).toBe(false);
		const request = {
			ref: { cwd: "/project", sessionId: "session" },
			snapshotId: "snapshot",
			scope: "workspace",
			paths: ["b.ts", "a.ts", "b.ts"],
			message: " commit ",
		};
		expect(schemas.commitChangeReviewRequestSchema.parse(request)).toEqual({ ...request, paths: ["b.ts", "a.ts"] });
		for (const scope of ["committed", "mixed", "external", "unpushed"]) {
			expect(schemas.commitChangeReviewRequestSchema.safeParse({ ...request, scope }).success).toBe(false);
		}
	});

	it("keeps mutable diff context separate from immutable turn snapshots", () => {
		const ref = { cwd: "/project", sessionId: "session" };
		const operation = createBuiltinOperationRef("request", CHANGE_REVIEW_DIFF_OWNER_ID, {
			scope: { kind: "session", ref },
			generation: 1,
			revision: null,
		});
		const request = {
			operation,
			ref,
			snapshotId: "snapshot",
			deadlineAt: 1,
			scope: "turn",
			turnId: "turn",
			path: "src/file.ts",
		};
		expect(schemas.changeReviewDiffRequestSchema.parse(request)).toEqual(request);
		expect(schemas.changeReviewDiffRequestSchema.safeParse({ ...request, contextLines: 20 }).success).toBe(false);
		expect(schemas.changeReviewDiffRequestSchema.safeParse({ ...request, scope: "workspace" }).success).toBe(false);
	});
});
