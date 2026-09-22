import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createBackgroundTasks } from "./background-tasks";
import { createBuiltinFeatures } from "../companions/builtin-features";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

describe.skipIf(process.platform === "win32")("Background tasks", () => {
	it("persists the settled task and its complete output, then serves both after the process is released", async () => {
		const home = await temporaryDirectory("background-tasks");
		const notify = vi.fn();
		const features = createBuiltinFeatures(home);
		const tasks = createBackgroundTasks({
			requireEnabled: () => features.requireEnabled("background-tasks"),
			home,
			assertProject: async () => undefined,
			assertSession: () => undefined,
			notify,
			onChanged: () => undefined,
		});
		const ref = { cwd: home, sessionId: "session" };
		try {
			await tasks.initialize();
			const expected = `${"输出".repeat(50_000)}END`;
			// Generate output in the child; Linux limits each launch argument to 128 KiB.
			const job = await tasks.start(
				ref,
				`${quote(process.execPath)} -e ${quote('process.stdout.write("输出".repeat(50_000) + "END")')}`,
			);
			await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce(), { timeout: 10_000 });
			await features.write(
				{ id: "background-tasks", enabled: false, expectedRevision: 0 },
				new AbortController().signal,
			);
			await expect(tasks.start(ref, "printf forbidden")).rejects.toMatchObject({
				lingError: { code: "BUILTIN_FEATURE_DISABLED" },
			});
			expect(await tasks.list(ref)).toMatchObject([{ id: job.id, status: "completed", exitCode: 0 }]);
			let output = "";
			let offset = 0;
			for (;;) {
				const part = await tasks.read(ref, job.id, offset);
				if (!part.text) break;
				output += part.text;
				offset = part.offset;
			}
			expect(output).toBe(expected);
			await expect(tasks.stop(ref, job.id)).resolves.toMatchObject({ status: "completed" });
		} finally {
			await tasks.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});
});
