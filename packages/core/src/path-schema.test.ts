import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { absolutePathSchema } from "./paths";
import { parsePiWorkerSessionRef } from "./pi-protocol/protocol-validation";
import { sessionRefSchema as piPayloadSessionRefSchema } from "./pi-protocol/runtime-payload-schemas";

describe("Node absolute path boundary", () => {
	it("uses the current operating system's absolute path rules", () => {
		const schema = absolutePathSchema("cwd");
		for (const value of [resolve("project"), "/project", "C:\\project", "\\\\server\\share"])
			expect(schema.safeParse(value).success).toBe(isAbsolute(value));
	});
	it("rejects relative, NUL and oversized input", () => {
		const schema = absolutePathSchema("cwd", 20);
		for (const value of ["project", "", "/project\0file", `/${"x".repeat(20)}`])
			expect(schema.safeParse(value).success).toBe(false);
	});
	it("preserves the different established Pi control and payload identity caps", () => {
		const cwd = resolve("project");
		expect(parsePiWorkerSessionRef({ cwd, sessionId: "s".repeat(160) }).sessionId).toHaveLength(160);
		expect(() => parsePiWorkerSessionRef({ cwd, sessionId: "s".repeat(161) })).toThrow();
		expect(piPayloadSessionRefSchema.parse({ cwd, sessionId: "s".repeat(4096) }).sessionId).toHaveLength(4096);
		expect(piPayloadSessionRefSchema.safeParse({ cwd, sessionId: "s".repeat(4097) }).success).toBe(false);
	});
});
