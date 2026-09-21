import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDatabase, type HostDatabase } from "../../storage/database";
import { createComposerHistory, type ComposerHistory } from "./composer-history";

const roots: string[] = [];
const histories: ComposerHistory[] = [];
const databases: HostDatabase[] = [];
async function createHistory() {
	const userDataDir = await temporaryDirectory("composer");
	roots.push(userDataDir);
	const database = createHostDatabase(userDataDir);
	databases.push(database);
	const history = createComposerHistory({ userDataDir, database });
	histories.push(history);
	return { history, userDataDir, database };
}
afterEach(async () => {
	await Promise.all(histories.splice(0).map((history) => history.dispose()));
	for (const database of databases.splice(0)) database.dispose();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("composer history ownership", () => {
	it("isolates cached histories and keeps queued writes through shutdown", async () => {
		const first = await createHistory();
		const second = await createHistory();
		const earlier = first.history.recordComposerHistoryEntry("/project", "first message", 1);
		const later = first.history.recordComposerHistoryEntry("/project", "second message", 2);
		const disposed = first.history.dispose();
		expect(first.history.dispose()).toBe(disposed);
		await Promise.all([earlier, later, disposed]);
		await expect(first.history.recordComposerHistoryEntry("/project", "late")).rejects.toMatchObject({
			code: "REQUEST_CANCELLED",
		});
		expect(second.history.listComposerHistoryEntries({ cwd: "/project" })).toEqual([]);
		const restarted = createComposerHistory({ userDataDir: first.userDataDir, database: first.database });
		histories.push(restarted);
		expect(restarted.listComposerHistoryEntries({ cwd: "/project" }).map((entry) => entry.text)).toEqual([
			"second message",
			"first message",
		]);
		expect(first.database.all("SELECT text FROM composer_history ORDER BY id")).toEqual([
			{ text: "first message" },
			{ text: "second message" },
		]);
	});
	it("imports legacy history once and preserves its original bytes after recording or clearing", async () => {
		const { history, userDataDir, database } = await createHistory();
		const source = join(userDataDir, "composer-history.jsonl");
		const original =
			JSON.stringify({ schema: "ling/composer-history", version: 1, writtenAt: 1 }) +
			"\n" +
			JSON.stringify({ cwd: "/project", text: "old draft", createdAt: 1 }) +
			"\n";
		await writeFile(source, original);
		expect(history.listComposerHistoryEntries({ cwd: "/project" })).toEqual([
			{ cwd: "/project", text: "old draft", createdAt: 1 },
		]);
		await history.recordComposerHistoryEntry("/project", "new draft", 2);
		await history.clearComposerHistory();
		const restored = createComposerHistory({ userDataDir, database });
		histories.push(restored);
		expect(restored.listComposerHistoryEntries({ cwd: "/project" })).toEqual([]);
		expect(await readFile(source, "utf8")).toBe(original);
	});
});
