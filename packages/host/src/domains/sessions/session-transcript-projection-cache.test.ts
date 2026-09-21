import { temporaryDirectory } from "../../../../../test/temporary-directory";
import type { SessionMessage } from "@ling/contracts/session";
import { mkdir, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionTranscriptProjectionCache } from "./session-transcript-projection-cache";

let directory: string;
const ref = { cwd: "/project", sessionId: "session" };
const message: SessionMessage = { id: "message", entryId: "entry", role: "user", occurredAt: 1, content: "hello" };
beforeEach(async () => {
	directory = await temporaryDirectory("projection-cache");
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const create = () => createSessionTranscriptProjectionCache({ userDataDir: directory, appVersion: "0.1.0" });
async function cachePath(): Promise<string> {
	const root = join(directory, "session-transcript-projections");
	const files = await readdir(root);
	if (files.length !== 1 || !files[0]) throw new Error("Expected exactly one cache file");
	return join(root, files[0]);
}

describe("optional transcript projection storage", () => {
	it("round-trips persisted messages and keeps the last cache when a larger projection opts out", async () => {
		const cache = create();
		expect(await cache.write(ref, "first", [message])).toBe("written");
		expect(await cache.read(ref, "first")).toEqual([message]);
		const before = await readFile(await cachePath(), "utf8");
		const large = { ...message, content: "界".repeat(6 * 1024 * 1024) };
		expect(await cache.write(ref, "second", [large])).toBe("projectionTooLarge");
		expect(await readFile(await cachePath(), "utf8")).toBe(before);
		expect(await cache.read(ref, "second")).toBeNull();
	});
	it("bypasses old oversized caches, while surfacing corrupt JSON and failed reads", async () => {
		const cache = create();
		await cache.write(ref, "first", [message]);
		const path = await cachePath();
		await truncate(path, 17 * 1024 * 1024);
		expect(await cache.read(ref, "first")).toBeNull();
		await writeFile(path, "{");
		await expect(cache.read(ref, "first")).rejects.toThrow("not valid JSON");
		await rm(path);
		await mkdir(path);
		await expect(cache.read(ref, "first")).rejects.toThrow("Expected a regular file");
		await rm(path, { recursive: true });
		expect(await cache.read(ref, "first")).toBeNull();
	});
});
