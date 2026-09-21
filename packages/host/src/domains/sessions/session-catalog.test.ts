import { createHostDatabase, type HostDatabase } from "../../storage/database";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionCatalogStore, type SessionCatalogStore } from "./session-catalog";
import {
	cachedSessionSummariesFromCatalog,
	parseSessionCatalogDocument,
	serializeSessionCatalog,
	type SessionCatalogSource,
} from "./session-catalog-document";

const roots: string[] = [];
const stores: SessionCatalogStore[] = [];
const databases: HostDatabase[] = [];
function database(userDataDir: string) {
	const instance = createHostDatabase(userDataDir);
	databases.push(instance);
	return instance;
}
async function createStore() {
	const userDataDir = await temporaryDirectory("catalog");
	roots.push(userDataDir);
	const store = createSessionCatalogStore({ userDataDir, database: database(userDataDir) });
	stores.push(store);
	const source: SessionCatalogSource = {
		id: "session",
		cwd: "/project",
		title: "Saved title",
		createdAt: 1,
		updatedAt: 2,
		messageCount: 1,
		preview: "message",
		sessionFilePath: join(userDataDir, "session.jsonl"),
	};
	await writeFile(source.sessionFilePath, "fixture");
	return { store, userDataDir, source };
}
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.dispose()));
	for (const instance of databases.splice(0)) instance.dispose();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session catalog ownership", () => {
	it("isolates metadata and drains admitted mutations before a restart", async () => {
		const first = await createStore();
		const second = await createStore();
		const ref = { cwd: first.source.cwd, sessionId: first.source.id };
		const mutation = first.store.updateMetadata([first.source], ref, { pinned: true });
		const disposed = first.store.dispose();
		expect(first.store.dispose()).toBe(disposed);
		await Promise.all([mutation, disposed]);
		await expect(first.store.snapshot()).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		expect(await second.store.snapshot()).toEqual([]);
		const restarted = createSessionCatalogStore({
			userDataDir: first.userDataDir,
			database: database(first.userDataDir),
		});
		stores.push(restarted);
		expect(await restarted.snapshot()).toEqual([expect.objectContaining({ ref, pinnedAt: expect.any(Number) })]);

		expect(
			database(first.userDataDir).get(
				"SELECT pinned_at FROM session_meta WHERE cwd=? AND session_id=?",
				ref.cwd,
				ref.sessionId,
			),
		).toMatchObject({ pinned_at: expect.any(Number) });
	});

	it("reports corrupt catalog reads and only replaces them through explicit recovery", async () => {
		const { store, userDataDir, source } = await createStore();
		await writeFile(join(userDataDir, "ling-session-catalog.json"), "{broken");
		await expect(store.snapshot()).rejects.toBeInstanceOf(Error);
		expect(await store.status()).toMatchObject({ status: "recoveryRequired" });
		await store.rebuild([source]);
		expect(await readFile(join(userDataDir, "ling-session-catalog.json"), "utf8")).toBe("{broken");
		expect(await store.status()).toEqual({ status: "ready" });
		expect(await store.snapshot()).toHaveLength(1);
	});
});

describe("fork provenance catalog migration", () => {
	const entry = {
		ref: { cwd: "/project", sessionId: "fork" },
		sessionFilePath: "/sessions/fork.jsonl",
		pinnedAt: 1,
		archivedAt: 2,
	};
	const cachedSummary = {
		title: "Renamed fork",
		createdAt: 1,
		updatedAt: 2,
		messageCount: 1,
		preview: "hello",
		parentSessionFilePath: "/sessions/original.jsonl",
		fingerprint: { size: 64, modifiedAtMs: 4 },
	};

	it("keeps v3 authoritative metadata", () => {
		const result = parseSessionCatalogDocument(
			JSON.stringify({
				schema: "ling/session-catalog",
				version: 3,
				writtenAt: 1,
				sessions: [entry],
			}),
		);
		expect(result).toEqual({ entries: [entry], migrated: true });
	});

	it("keeps v4 metadata but does not reuse a summary without origin evidence", () => {
		const result = parseSessionCatalogDocument(
			JSON.stringify({
				schema: "ling/session-catalog",
				version: 4,
				writtenAt: 1,
				sessions: [{ ...entry, cachedSummary }],
			}),
		);
		expect(result.migrated).toBe(true);
		expect(result.entries[0]).toMatchObject(entry);
		const [summary] = cachedSessionSummariesFromCatalog(result.entries);
		expect(summary).toMatchObject({
			title: "Renamed fork",
			parentSessionFilePath: cachedSummary.parentSessionFilePath,
		});
		expect(summary?.sourceFingerprint).toBeUndefined();
	});

	it("persists origin evidence with v5 summaries and reuses their fingerprint", () => {
		const result = parseSessionCatalogDocument(
			serializeSessionCatalog([{ ...entry, cachedSummary: { ...cachedSummary, manualFork: true } }]),
		);
		expect(result.migrated).toBe(false);
		expect(cachedSessionSummariesFromCatalog(result.entries)[0]).toMatchObject({
			manualFork: true,
			title: "Renamed fork",
			sourceFingerprint: cachedSummary.fingerprint,
		});
	});
});
