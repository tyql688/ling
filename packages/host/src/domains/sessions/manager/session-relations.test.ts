import { describe, expect, it } from "vitest";
import { attachSessionRelations } from "./session-relations";

const original = { id: "original", cwd: "/project", title: "Original", sessionFilePath: "/sessions/original.jsonl" };
const fork = {
	id: "fork",
	cwd: "/project",
	title: "Renamed conversation",
	sessionFilePath: "/sessions/fork.jsonl",
	parentSessionFilePath: original.sessionFilePath,
	manualFork: true,
};

describe("session relation projection", () => {
	it("keeps a renamed manual fork separate from its original", () => {
		const summaries = attachSessionRelations([original, fork]);
		expect(summaries[0]?.relation).toBeUndefined();
		expect(summaries[1]?.relation).toEqual({
			kind: "manualFork",
			parentRef: { cwd: "/project", sessionId: "original" },
			parentSessionFilePath: original.sessionFilePath,
		});
	});

	it("does not let a plugin's display title override origin evidence", () => {
		const child = {
			...fork,
			manualFork: false,
			title: "Child (fork)",
			sessionFilePath: "/sessions/subagents/child.jsonl",
		};
		expect(attachSessionRelations([original, child])[1]?.relation).toMatchObject({
			kind: "child",
			confidence: "strong",
			source: "subagent",
		});
	});

	it("keeps a fork visible as a standalone session after its parent is removed", () => {
		expect(attachSessionRelations([fork])[0]?.relation).toBeUndefined();
	});
});
