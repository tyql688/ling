import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { sessionControlSchema } from "@ling/contracts/session-inspection";
import { defaultSessionToolFilter } from "@ling/contracts/session-tool-filter";
import { appendSessionToolFilter, readSessionToolFilter } from "./session-tool-filter";

it("keeps filter scope on the session file and inherits the selected history when forking", () => {
	const manager = SessionManager.inMemory();
	expect(readSessionToolFilter(manager)).toEqual(defaultSessionToolFilter());
	const root = manager.appendMessage({ role: "user", content: "Root", timestamp: 0 });
	const filter = { tools: ["read", "mcp__docs__*"], excludeTools: ["*delete*"], disableMcp: true };
	appendSessionToolFilter(manager, filter);
	const leaf = manager.getLeafId()!;
	manager.branch(root);
	expect(readSessionToolFilter(manager)).toEqual(filter);
	manager.createBranchedSession(leaf);
	expect(readSessionToolFilter(manager)).toEqual(filter);
	manager.createBranchedSession(root);
	expect(readSessionToolFilter(manager)).toEqual(defaultSessionToolFilter());
});

it("rejects malformed or unsupported persisted filters instead of enabling tools", () => {
	for (const data of [
		{ version: 2, filter: defaultSessionToolFilter() },
		{ version: 1, filter: { tools: [] } },
	]) {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("ling:tool-filter", data);
		expect(() => readSessionToolFilter(manager)).toThrow();
	}
});

it("bounds compiled patterns and distinguishes inherited defaults from disabling every tool", () => {
	const action = (tools: unknown, excludeTools: unknown = []) => ({
		type: "toolFilter",
		filter: { tools, excludeTools, disableMcp: false },
	});
	expect(sessionControlSchema.parse(action(null))).toEqual(action(null));
	expect(sessionControlSchema.parse(action([]))).toEqual(action([]));
	expect(sessionControlSchema.parse(action(["read", "mcp__*"], ["*delete*"]))).toEqual(
		action(["read", "mcp__*"], ["*delete*"]),
	);
	for (const tools of [[" "], ["x".repeat(1025)], Array.from({ length: 129 }, (_, i) => `tool_${i}`)]) {
		expect(sessionControlSchema.safeParse(action(tools)).success).toBe(false);
		expect(sessionControlSchema.safeParse(action(null, tools)).success).toBe(false);
	}
});
