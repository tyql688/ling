import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { diffSelectionComment } from "./diff-selection";

const patch =
	"--- a/task.ts\n+++ b/task.ts\n@@ -10,3 +10,3 @@\n const before = true;\n-old value\n+new value\n unchanged\n@@ -30 +30 @@\n-last old\n+last new\n\\ No newline at end of file\n";

describe("displayed diff comment coordinates", () => {
	it("uses actual sparse hunk coordinates and preserves deletion and no-newline text", () => {
		const file = parsePatchFiles(patch, undefined, true)[0]!.files[0]!;
		expect(diffSelectionComment(file, { start: 11, end: 11, side: "deletions" })).toEqual({
			rangeLabel: "old L11",
			excerpt: "-old value",
		});
		expect(diffSelectionComment(file, { start: 30, end: 30 })).toEqual({ rangeLabel: "L30", excerpt: "+last new" });
	});
	it("captures both sides and supports reverse selections", () => {
		const file = parsePatchFiles(patch, undefined, true)[0]!.files[0]!;
		expect(diffSelectionComment(file, { start: 11, end: 11, side: "deletions", endSide: "additions" }).excerpt).toBe(
			"-old value\n+new value",
		);
		expect(diffSelectionComment(file, { start: 12, end: 10 }).excerpt).toBe(
			" const before = true;\n-old value\n+new value\n unchanged",
		);
	});
	it("includes expanded unchanged lines and bounds large excerpts", () => {
		const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
		const file = parseDiffFromFile(
			{ name: "task.txt", contents: original },
			{ name: "task.txt", contents: original.replace("line 50", "changed 50") },
			undefined,
			true,
		);
		expect(diffSelectionComment(file, { start: 70, end: 71 }).excerpt).toBe(" line 70\n line 71");
		const result = diffSelectionComment(file, { start: 1, end: 100 });
		expect(result.excerpt.split("\n")).toHaveLength(41);
		expect(result.excerpt.endsWith("line 40\n…")).toBe(true);
	});
	it("does not materialize an absent side in added, deleted or equal files", () => {
		const oldFile = { name: "task.txt", contents: "one\ntwo\n" };
		const empty = { ...oldFile, contents: "" };
		expect(
			diffSelectionComment(parseDiffFromFile(oldFile, empty), { start: 1, end: 2, side: "deletions" }).excerpt,
		).toBe("-one\n-two");
		expect(diffSelectionComment(parseDiffFromFile(empty, oldFile), { start: 1, end: 2 }).excerpt).toBe("+one\n+two");
		expect(diffSelectionComment(parseDiffFromFile(oldFile, oldFile), { start: 2, end: 2 }).excerpt).toBe(" two");
	});
});
