import { describe, expect, it } from "vitest";
import { readTodoResult, todoProgress, todoDetailsSchema } from "./todo";
const details = {
	action: "update",
	nextId: 3,
	tasks: [
		{ id: 1, subject: "Inspect", status: "completed" },
		{
			id: 2,
			subject: "Implement",
			status: "in_progress",
			activeForm: "Implementing",
			blockedBy: [1],
			owner: "agent",
			metadata: { ticket: 42 },
		},
	],
};
describe("rpiv-todo result adaptation", () => {
	it("keeps unfinished work explicit without rewriting upstream status or counting tombstones", () => {
		const value = todoDetailsSchema.parse({
			...details,
			tasks: [...details.tasks, { id: 3, subject: "Cancelled", status: "deleted" }],
		});
		expect(todoProgress(value)).toEqual({ total: 2, completed: 1, open: [details.tasks[1]] });
		expect(value.tasks[1]?.status).toBe("in_progress");
		expect(todoProgress({ tasks: [], nextId: 1 })).toEqual({ total: 0, completed: 0, open: [] });
	});
	it("retains upstream task identities, dependency links and optional data", () => {
		const origin = (source: string, extension: string, version: string) => ({
			source,
			extension,
			version,
			scope: "global" as const,
			revision: "a".repeat(64),
		});
		const snapshot = (value: ReturnType<typeof origin> | null) => ({
			toolCallId: "call",
			origin: value,
			details,
			isError: false,
		});
		const result = readTodoResult(snapshot(origin("npm:@juicesharp/rpiv-todo@2.10.1", "index.ts", "2.10.1")));
		expect(result?.tasks).toEqual(details.tasks);
		expect(readTodoResult(snapshot(origin("ling:ling-todo", "pi.js", "1.0.0")))).toEqual(result);
		expect(readTodoResult(snapshot(origin("ling:todo", "index.ts", "2.10.1")))).toEqual(result);
	});
	it("does not reinterpret unknown providers or broken data as an empty todo list", () => {
		const base = { scope: "global" as const, revision: "a".repeat(64) };
		for (const origin of [
			null,
			{ ...base, source: "npm:@juicesharp/rpiv-todo-other", extension: "index.ts", version: "2.10.1" },
			{ ...base, source: "npm:@juicesharp/rpiv-todo", extension: "index.ts", version: "3.0.0" },
			{ ...base, source: "npm:@juicesharp/rpiv-todo", extension: "index.ts", version: "2.9.0" },
		])
			expect(() => readTodoResult({ toolCallId: "call", origin, details, isError: false })).toThrow("unverified");
		expect(() =>
			readTodoResult({
				toolCallId: "call",
				origin: { ...base, source: "ling:ling-todo", extension: "pi.js", version: "1.0.0" },
				details: { tasks: [] },
				isError: false,
			}),
		).toThrow();
		expect(readTodoResult(null)).toBeNull();
	});
});
