import { shellProcedures } from "./api/shell-procedures";
import { describe, expect, it } from "vitest";
import { viewedSessionRefSchema } from "./session-shell-validation";
import { sessionRefSchema } from "./session-ref";

describe("browser-safe session references", () => {
	it("accepts native path forms without importing Node", () => {
		for (const cwd of ["/project", "C:\\project", "\\\\server\\share"])
			expect(sessionRefSchema.parse({ cwd, sessionId: "session" })).toEqual({ cwd, sessionId: "session" });
		expect(viewedSessionRefSchema.parse(null)).toBeNull();
	});
	it("rejects invalid identities, NUL paths and extra fields", () => {
		for (const sessionId of ["", "__proto__", "constructor", "prototype", "a\0b"])
			expect(sessionRefSchema.safeParse({ cwd: "/project", sessionId }).success).toBe(false);
		expect(sessionRefSchema.safeParse({ cwd: "/a\0b", sessionId: "session" }).success).toBe(false);
		expect(sessionRefSchema.safeParse({ cwd: "/project", sessionId: "session", stale: true }).success).toBe(false);
	});
	it("rejects relative and drive-relative request paths without changing native spelling", () => {
		for (const cwd of ["project", "C:project", "~/project", " "])
			expect(sessionRefSchema.safeParse({ cwd, sessionId: "session" }).success).toBe(false);
		for (const cwd of ["/project with spaces", "C:/project", "\\project"])
			expect(sessionRefSchema.parse({ cwd, sessionId: "session" }).cwd).toBe(cwd);
	});
});

describe("native shell procedure admission", () => {
	it("rejects prototype permission names, external schemes and unsupported native zoom", () => {
		expect(() => shellProcedures.app.getSystemPermission.parse(["constructor"])).toThrow();
		expect(() => shellProcedures.app.openExternal.parse(["file:///private/data"])).toThrow();
		expect(() => shellProcedures.window.setZoomFactor.parse([2])).toThrow();
		expect(shellProcedures.window.setZoomFactor.parse([1.5])).toEqual([1.5]);
		expect(shellProcedures.window.setTheme.parse([{ source: "dark", foreground: "#ffffff" }])).toEqual([
			{ source: "dark", foreground: "#ffffff" },
		]);
	});
});
