import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { appendFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUsageScanner, type UsageScanner } from "@ling/host/workers/usage/usage-scan";

function entry(id: string, timestamp: number): string {
	return JSON.stringify({ type: "message", id, message: { role: "user", timestamp } }) + "\n";
}

async function withScanners(run: (dir: string, first: UsageScanner, second: UsageScanner) => Promise<void>) {
	const dir = await temporaryDirectory("usage-scan");
	const first = createUsageScanner();
	const second = createUsageScanner();
	try {
		await run(dir, first, second);
	} finally {
		await Promise.all([first.dispose(), second.dispose()]);
		await rm(dir, { recursive: true, force: true });
	}
}

describe("usage scanner ownership", () => {
	it("counts cache-warming usage with its model identity alongside older assistant and summary entries", async () => {
		await withScanners(async (dir, scanner) => {
			const usage = { input: 10, output: 1, cacheRead: 100, cacheWrite: 0, totalTokens: 111, cost: { total: 0.002 } };
			const timestamp = new Date(100).toISOString();
			const warming = {
				type: "usage",
				id: "warm",
				timestamp,
				kind: "cache_warm",
				provider: "test",
				model: "model/variant",
				usage,
			};
			await writeFile(
				join(dir, "session.jsonl"),
				[
					{ type: "message", id: "system", timestamp, message: { role: "system", content: "Instructions" } },
					{
						type: "message",
						id: "answer",
						timestamp,
						message: { role: "assistant", provider: "test", model: "model/variant", usage },
					},
					{ type: "compaction", id: "summary", timestamp, usage },
					warming,
				]
					.map((value) => JSON.stringify(value))
					.join("\n") + "\n",
			);
			const records = (await scanner.scanFiles(dir, 0)).files[0]?.records;
			expect(records).toHaveLength(3);
			expect(records?.[2]).toMatchObject({
				role: "usage",
				source: "other",
				provider: "test",
				model: "model/variant",
				dedupeKey: "warm:100",
				usage: { totalTokens: 111, cost: 0.002 },
			});
			await writeFile(join(dir, "fork.jsonl"), JSON.stringify(warming) + "\n");
			const scans = await scanner.scanFiles(dir, 0);
			expect(
				scans.files.flatMap((file) => file.records).filter((record) => record.dedupeKey === "warm:100"),
			).toHaveLength(2);
		});
	});
	it("shares concurrent work and cached records only within the owning scanner", async () => {
		await withScanners(async (dir, first, second) => {
			await writeFile(join(dir, "session.jsonl"), entry("first", 100));
			const pending = first.scanFiles(dir, 0);
			expect(first.scanFiles(dir, 0)).toBe(pending);
			const initial = await pending;
			const warm = await first.scanFiles(dir, 0);
			const independent = await second.scanFiles(dir, 0);
			expect(warm.files[0]?.records).toBe(initial.files[0]?.records);
			expect(independent).toEqual(initial);
			expect(independent.files[0]?.records).not.toBe(initial.files[0]?.records);
			await first.dispose();
			await expect(first.scanFiles(dir, 0)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
			expect(await second.scanFiles(dir, 0)).toEqual(initial);
		});
	});

	it("invalidates same-size rewrites with restored mtime and sees later appends", async () => {
		await withScanners(async (dir, scanner) => {
			const file = join(dir, "session.jsonl");
			await writeFile(file, entry("before", 100));
			const initial = await scanner.scanFiles(dir, 0);
			const metadata = await stat(file);
			await writeFile(file, entry("after!", 100));
			await utimes(file, metadata.atime, metadata.mtime);
			const rewritten = await scanner.scanFiles(dir, 0);
			expect(rewritten.files[0]?.records[0]?.dedupeKey).toBe("after!:100");
			expect(rewritten.files[0]?.records).not.toBe(initial.files[0]?.records);
			await appendFile(file, entry("appended", 200));
			expect((await scanner.scanFiles(dir, 0)).files[0]?.records).toHaveLength(2);
		});
	});

	it("keeps complete files and an explicit failure count until a malformed file is repaired", async () => {
		await withScanners(async (dir, scanner) => {
			await writeFile(join(dir, "valid.jsonl"), entry("valid", 100));
			const broken = join(dir, "broken.jsonl");
			await writeFile(broken, entry("prefix", 100) + "{unfinished\n");
			const partial = await scanner.scanFiles(dir, 0);
			expect(partial.skippedFileCount).toBe(1);
			expect(partial.files).toHaveLength(1);
			expect(partial.files[0]?.records[0]?.dedupeKey).toBe("valid:100");
			await writeFile(broken, entry("repaired", 100));
			const complete = await scanner.scanFiles(dir, 0);
			expect(complete.skippedFileCount).toBe(0);
			expect(complete.files).toHaveLength(2);
		});
	});

	it("does not reuse a narrower cached window for a wider range", async () => {
		await withScanners(async (dir, scanner) => {
			await writeFile(join(dir, "session.jsonl"), entry("old", 100) + entry("recent", 300));
			await scanner.scanFiles(dir, 0);
			expect((await scanner.scanFiles(dir, 200)).files[0]?.records).toHaveLength(1);
			const [wide, narrow] = await Promise.all([scanner.scanFiles(dir, 0), scanner.scanFiles(dir, 200)]);
			expect(wide.files[0]?.records).toHaveLength(2);
			expect(narrow.files[0]?.records).toHaveLength(1);
			expect((await scanner.scanFiles(dir, 0)).files[0]?.records).toHaveLength(2);
		});
	});

	it("drains cancelled scans, refuses later admission and keeps disposal idempotent", async () => {
		await withScanners(async (dir, scanner) => {
			await writeFile(join(dir, "session.jsonl"), entry("pending", 100).repeat(20_000));
			const pending = scanner.scanFiles(dir, 0);
			const rejected = expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
			const disposal = scanner.dispose();
			expect(scanner.dispose()).toBe(disposal);
			await disposal;
			await rejected;
			await expect(scanner.scanFiles(dir, 0)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		});
	});

	it("treats a missing sessions directory as fresh installation but propagates an invalid directory", async () => {
		await withScanners(async (dir, scanner) => {
			expect(await scanner.scanFiles(join(dir, "missing"), 0)).toEqual({ files: [], skippedFileCount: 0 });
			const file = join(dir, "file.jsonl");
			await writeFile(file, entry("record", 100));
			await expect(scanner.scanFiles(file, 0)).rejects.toMatchObject({ code: "ENOTDIR" });
		});
	});
});
