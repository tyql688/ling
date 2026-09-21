import { describe, expect, it } from "vitest";
import {
	terminalHostEventSchema,
	terminalHostInputSchema,
	terminalHostPidSchema,
	terminalHostRequestSchema,
} from "./terminal-host-protocol";

describe("terminal worker boundary", () => {
	it("keeps zero ConPTY ids valid and rejects invalid process responses", () => {
		expect(terminalHostPidSchema.parse(0)).toBe(0);
		expect(terminalHostPidSchema.parse(null)).toBeNull();
		expect(terminalHostPidSchema.safeParse(-1).success).toBe(false);
	});
	it("checks paths and geometry again in the process that spawns the PTY", () => {
		const create = {
			kind: "create",
			terminalId: "terminal-1",
			generation: 1,
			cwd: "/project",
			shellPath: "/bin/sh",
			args: [],
			cols: 80,
			rows: 24,
		};
		expect(terminalHostRequestSchema.safeParse(create).success).toBe(true);
		for (const invalid of [{ cwd: "relative" }, { shellPath: "/bin/\0sh" }, { cols: 501 }, { rows: 0 }])
			expect(terminalHostRequestSchema.safeParse({ ...create, ...invalid }).success).toBe(false);
	});
	it("keeps acknowledgements consistent with output and rejects wrong frame directions", () => {
		const output = { kind: "output", terminalId: "terminal-1", generation: 1, sequence: 1, ackUnits: 2, data: "ok" };
		expect(terminalHostEventSchema.safeParse(output).success).toBe(true);
		expect(terminalHostEventSchema.safeParse({ ...output, ackUnits: 1 }).success).toBe(false);
		expect(terminalHostInputSchema.safeParse({ kind: "dispose" }).success).toBe(false);
		expect(
			terminalHostRequestSchema.safeParse({ kind: "input", terminalId: "terminal-1", generation: 1, data: "x" })
				.success,
		).toBe(false);
	});
});
