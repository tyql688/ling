import { describe, expect, it } from "vitest";
import { resolveProjectPath } from "./project-path";

describe("reading project paths", () => {
	it("resolves document siblings and parent images within the project", () => {
		expect(
			resolveProjectPath("../image%20one.png", "/work/app", { documentPath: "docs/notes.md", sourceKind: "url" }),
		).toBe("image one.png");
		expect(resolveProjectPath("./intro.md", "/work/app", { documentPath: "docs/notes.md", sourceKind: "url" })).toBe(
			"docs/intro.md",
		);
	});
	it("keeps outside roots, URL schemes and traversal out of project requests", () => {
		for (const path of [
			"/work/app-old/a.md",
			"../../secret",
			"https://example.com/a.md",
			"data:text/plain,test",
			"a\0b",
		])
			expect(resolveProjectPath(path, "/work/app", { documentPath: "docs/notes.md", sourceKind: "url" })).toBeNull();
	});
	it("handles drive letters and separators without treating scoped project names as URLs", () => {
		expect(resolveProjectPath("file:///C:/Work/App/docs/a.md", "C:\\Work\\App", { sourceKind: "url" })).toBe(
			"docs/a.md",
		);
		expect(resolveProjectPath("..\\a.md", "C:\\Work\\App", { documentPath: "docs/notes.md" })).toBe("a.md");
		expect(resolveProjectPath("@scope/file.md", "/work/app")).toBe("@scope/file.md");
	});
	it("preserves literal filenames in tool arguments and decodes Markdown URLs once", () => {
		expect(resolveProjectPath("images/100%20done.png", "/work/app")).toBe("images/100%20done.png");
		expect(resolveProjectPath("images/100%2520done.png", "/work/app", { sourceKind: "url" })).toBe(
			"images/100%20done.png",
		);
		expect(resolveProjectPath("notes:today.md", "/work/app")).toBe("notes:today.md");
	});
});
