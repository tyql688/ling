import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createBackgroundProcesses } from "./processes";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const command = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;

describe.skipIf(process.platform === "win32")("Background processes", () => {
	it("releases failed spawns and refuses new processes after shutdown", async () => {
		const cwd = await temporaryDirectory("background-failed-spawn");
		const processes = createBackgroundProcesses(() => undefined);
		const missing = { cwd: join(cwd, "missing"), sessionId: "test" };
		try {
			await expect(processes.start(missing, command("process.exit(0)"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(processes.list(missing)).toEqual([]);
			await processes.release();
			await expect(processes.start({ cwd, sessionId: "test" }, command("process.exit(0)"))).rejects.toThrow("stopping");
		} finally {
			await processes.release();
			await rm(cwd, { recursive: true });
		}
	});

	it("keeps independent UTF-8 cursors and the complete retained tail after exit", async () => {
		const cwd = await temporaryDirectory("background-output");
		const processes = createBackgroundProcesses(() => undefined);
		try {
			const job = await processes.start(
				{ cwd, sessionId: "test" },
				command('process.stdout.write("你好".repeat(400000) + "END")'),
			);
			await expect(processes.wait(job.id)).resolves.toMatchObject({ status: "completed", exitCode: 0 });
			const first = processes.read(job.id, 0);
			expect(first.truncated).toBe(true);
			expect(processes.read(job.id, 0)).toEqual(first);
			let output = first.text;
			let offset = first.offset;
			for (;;) {
				const part = processes.read(job.id, offset);
				if (!part.text) break;
				output += part.text;
				expect(part.offset).toBeGreaterThan(offset);
				offset = part.offset;
			}
			expect(output.endsWith("END")).toBe(true);
			expect(output).not.toContain("�");
			expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2 * 1_048_576);
			expect(() => processes.read("missing", 0)).toThrow(/Unknown/);
		} finally {
			await processes.release();
			await rm(cwd, { recursive: true });
		}
	});
	it("cleans a child even when its shell exits before it, and confirms cancellation", async () => {
		const cwd = await temporaryDirectory("background-process-tree");
		const processes = createBackgroundProcesses(() => undefined);
		try {
			const ref = { cwd, sessionId: "test" };
			const job = await processes.start(
				ref,
				command(
					'const p=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(p.pid); p.unref();',
				),
			);
			await expect(processes.wait(job.id)).resolves.toMatchObject({
				status: "completed",
				exitCode: 0,
				error: null,
			});
			const pid = Number(processes.read(job.id, 0).text.trim());
			expect(pid).toBeGreaterThan(1);
			expect(() => process.kill(pid, 0)).toThrow();
			const running = await processes.start(ref, command("setInterval(()=>{},1000)"));
			await expect(processes.stop(running.id)).resolves.toMatchObject({ status: "cancelled" });
		} finally {
			await processes.release();
			await rm(cwd, { recursive: true });
		}
	});
});
