import { temporaryDirectory } from "../../../test/temporary-directory";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaunchLog } from "./launch-log";

let directory: string;
beforeEach(async () => {
	directory = await temporaryDirectory("launch-log");
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("bounded launch diagnostics", () => {
	it("keeps recent launches without pruning unrelated files", async () => {
		await writeFile(join(directory, "notes.log"), "keep");
		for (let index = 0; index < 12; index += 1) {
			const log = createLaunchLog(directory);
			try {
				log.write("error", `failure ${index}`);
				expect(await readFile(log.path, "utf8")).toContain(`failure ${index}`);
			} finally {
				log.dispose();
			}
		}
		expect(await readdir(directory)).toHaveLength(11);
		expect(await readFile(join(directory, "notes.log"), "utf8")).toBe("keep");
	});
	it("caps UTF-8 bytes, closes once, and refuses further writes after disposal", async () => {
		const log = createLaunchLog(directory);
		try {
			log.write("error", "fatal marker");
			log.write("info", "界".repeat(12 * 1024 * 1024));
			log.write("error", "after cap");
			const contents = await readFile(log.path, "utf8");
			expect(contents).toContain("fatal marker");
			expect(contents).toContain("Log cap reached");
			expect(contents).not.toContain("after cap");
			expect((await stat(log.path)).size).toBeLessThanOrEqual(32 * 1024 * 1024);
		} finally {
			log.dispose();
			log.dispose();
		}
		const bytes = (await stat(log.path)).size;
		log.write("error", "after dispose");
		expect((await stat(log.path)).size).toBe(bytes);
	});
});
