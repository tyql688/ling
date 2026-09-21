import { temporaryDirectory } from "../../../../test/temporary-directory";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAtomicFileStore, readUtf8FileBounded, writeTextFileAtomic } from "./atomic-file-store";

let directory: string;
beforeEach(async () => {
	directory = await temporaryDirectory("store-test");
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("atomic file ownership", () => {
	it("serializes publications and lets the latest queued contents win", async () => {
		const file = join(directory, "text");
		const accepted = Array.from({ length: 16 }, (_, index) => writeTextFileAtomic(file, String(index)));
		await Promise.all(accepted);
		expect(await readFile(file, "utf8")).toBe("15");
		await writeTextFileAtomic(file, "next");
		expect(await readFile(file, "utf8")).toBe("next");
	});

	it("distinguishes a missing file from an oversized read or malformed store", async () => {
		const file = join(directory, "state");
		expect(await readUtf8FileBounded(file, 4)).toBeUndefined();
		await writeFile(file, "oversized");
		await expect(readUtf8FileBounded(file, 4)).rejects.toThrow();
		const store = createAtomicFileStore({
			getPath: () => file,
			lockPath: "target",
			maxBytes: 1024,
			create: () => ({}),
			parse: (source) => JSON.parse(source) as object,
			serialize: JSON.stringify,
		});
		await expect(store.read()).rejects.toThrow();
	});

	it("serializes read-modify-write across store instances sharing one path", async () => {
		const file = join(directory, "counter");
		const create = () =>
			createAtomicFileStore({
				getPath: () => file,
				lockPath: "target",
				maxBytes: 1024,
				create: () => ({ count: 0 }),
				parse: (source) => JSON.parse(source) as { count: number },
				serialize: JSON.stringify,
			});
		const first = create();
		const second = create();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const one = first.update(async (value) => {
			entered.resolve();
			await release.promise;
			value.count++;
		});
		await entered.promise;
		const two = second.update((value) => {
			value.count++;
		});
		release.resolve();
		await Promise.all([one, two]);
		expect(await first.read()).toEqual({ count: 2 });
	});

	it("cancels queued transactions without applying their mutation", async () => {
		const file = join(directory, "counter");
		const store = createAtomicFileStore({
			getPath: () => file,
			lockPath: "target",
			maxBytes: 1024,
			create: () => ({ count: 0 }),
			parse: (source) => JSON.parse(source) as { count: number },
			serialize: JSON.stringify,
		});
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const first = store.update(async (value) => {
			entered.resolve();
			await release.promise;
			value.count++;
		});
		await entered.promise;
		const controller = new AbortController();
		const cancelled = store.update(
			(value) => {
				value.count += 100;
			},
			{ signal: controller.signal },
		);
		const rejected = expect(cancelled).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		controller.abort();
		await rejected;
		release.resolve();
		await first;
		expect(await store.read()).toEqual({ count: 1 });
	});
});
