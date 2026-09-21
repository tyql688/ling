import { temporaryDirectory } from "../../../test/temporary-directory";
import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAtomicTextFileWriter } from "./atomic-file";

let directory: string;
beforeEach(async () => {
	directory = await temporaryDirectory("atomic-library");
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const create = (mode?: number) =>
	createAtomicTextFileWriter({
		...(mode === undefined ? {} : { mode }),
		onWarning: vi.fn(),
	});

describe("shared atomic publication", () => {
	it.runIf(process.platform !== "win32")("retains existing permissions and supports private native state", async () => {
		const file = join(directory, "state");
		await writeFile(file, "before");
		await chmod(file, 0o640);
		await create()(file, "after");
		expect((await stat(file)).mode & 0o777).toBe(0o640);
		await create(0o600)(file, "private");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});
	it.runIf(process.platform !== "win32")("preserves a dotfile symlink and rejects a broken link", async () => {
		const target = join(directory, "target"),
			link = join(directory, "link");
		await writeFile(target, "before");
		await symlink(target, link);
		const write = create();
		await write(link, "after");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe("after");
		await rm(target);
		await expect(write(link, "lost")).rejects.toThrow("symlink target does not exist");
	});
	it("releases the queue after failure without blocking other paths or a later retry", async () => {
		const write = create(),
			broken = join(directory, "broken");
		await mkdir(broken);
		await expect(write(broken, "no")).rejects.toThrow();
		await write(join(directory, "healthy"), "ok");
		await rm(broken, { recursive: true });
		await write(broken, "recovered");
		expect(await readFile(broken, "utf8")).toBe("recovered");
	});
});
