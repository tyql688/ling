import { readFile, readdir, rm } from "node:fs/promises";
import { relative } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createAttachmentFiles } from "./attachment-files";

it("publishes imported bytes within the data home and keeps their path readable after restart", async () => {
	const root = await temporaryDirectory("attachment-files");
	const files = createAttachmentFiles(root);
	try {
		const path = await files.store(
			"/project",
			"../../clip.mp4",
			Readable.from([Buffer.from("first"), Buffer.from("second")]),
		);
		expect(relative(root, path).startsWith("..")).toBe(false);
		expect(path.endsWith("clip.mp4")).toBe(true);
		const longName = await files.store("/project", `${"视频".repeat(60)}.webm`, Readable.from(["video"]));
		expect(longName.endsWith(".webm")).toBe(true);
		expect(longName).not.toContain("\uFFFD");
		expect(await readFile(longName, "utf8")).toBe("video");
		await files.dispose();
		expect(await readFile(path, "utf8")).toBe("firstsecond");
		await expect(files.store("/project", "late.txt", Readable.from([]))).rejects.toThrow("shutting down");
	} finally {
		await files.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("removes partial bytes when a transfer fails or the owner shuts down", async () => {
	const root = await temporaryDirectory("attachment-interrupted");
	const files = createAttachmentFiles(root);
	try {
		const body = new PassThrough();
		const pending = files.store("/project", "clip.mp4", body);
		const rejection = expect(pending).rejects.toThrow();
		body.write("partial");
		await files.dispose();
		await rejection;
		const entries = await readdir(root, { recursive: true });
		expect(entries.some((entry) => entry.endsWith(".part") || entry.endsWith(".mp4"))).toBe(false);
	} finally {
		await files.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
