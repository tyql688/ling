import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../test/temporary-directory";
import { createHostDatabase, type HostDatabase } from "./database";
const roots: string[] = [];
const owners: HostDatabase[] = [];
async function create() {
	const root = await temporaryDirectory("database");
	roots.push(root);
	return root;
}
afterEach(async () => {
	for (const owner of owners.splice(0)) owner.dispose();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("commits imported data with its marker once, retaining the legacy bytes", async () => {
	const root = await create(),
		file = join(root, "legacy.json");
	await writeFile(file, '{"value":"old"}');
	const db = createHostDatabase(root);
	owners.push(db);
	let reads = 0;
	const spec = {
		key: "test",
		source: file,
		read() {
			reads++;
			return "old";
		},
		publish(value: string) {
			db.run("INSERT INTO app_settings VALUES('test',?)", JSON.stringify(value));
		},
	};
	db.importLegacy(spec);
	db.importLegacy(spec);
	expect(reads).toBe(1);
	expect(await readFile(file, "utf8")).toBe('{"value":"old"}');
	db.dispose();
	const reopened = createHostDatabase(root);
	owners.push(reopened);
	expect(reopened.get("SELECT value FROM app_settings WHERE key='test'")).toEqual({ value: '"old"' });
	expect(reopened.health().status).toBe("ready");
});
it("rolls back a failed dataset while retaining independent complete imports and supports a retry", async () => {
	const root = await create(),
		db = createHostDatabase(root);
	owners.push(db);
	const broken = new Error("invalid old catalog");
	expect(() =>
		db.importLegacy({
			key: "catalog",
			source: "catalog.json",
			read: () => [],
			publish() {
				db.run("INSERT INTO projects(cwd,is_open) VALUES('/project',1)");
				throw broken;
			},
		}),
	).toThrow(broken);
	expect(db.all("SELECT * FROM projects")).toEqual([]);
	expect(db.health()).toMatchObject({
		status: "degraded",
		issues: [{ key: "catalog", message: "invalid old catalog" }],
	});
	db.importLegacy({
		key: "settings",
		source: "settings.json",
		read: () => true,
		publish(value) {
			db.run("INSERT INTO app_settings VALUES('ok',?)", JSON.stringify(value));
		},
	});
	expect(db.get("SELECT value FROM app_settings WHERE key='ok'")).toEqual({ value: "true" });
	db.importLegacy({
		key: "catalog",
		source: "catalog.json",
		read: () => [],
		publish() {
			db.run("INSERT INTO projects(cwd,is_open) VALUES('/project',1)");
		},
	});
	expect(db.health().status).toBe("ready");
});
it("refuses a future schema without rewriting it and can retry after the incompatible file is explicitly removed", async () => {
	const root = await create();
	const raw = new DatabaseSync(join(root, "ling.sqlite"));
	raw.exec("CREATE TABLE schema_version(version INTEGER NOT NULL) STRICT; INSERT INTO schema_version VALUES(999)");
	raw.close();
	const db = createHostDatabase(root);
	owners.push(db);
	expect(db.health().status).toBe("unavailable");
	expect(() => db.run("DELETE FROM schema_version")).toThrow("Ling data is unavailable");
	const inspect = new DatabaseSync(db.path);
	expect(inspect.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 999 });
	inspect.close();
	await rm(db.path);
	expect(db.retry().status).toBe("ready");
});

it("deletes session metadata atomically and preserves unrelated sessions on rollback", async () => {
	const root = await create(),
		db = createHostDatabase(root);
	owners.push(db);
	for (const sessionId of ["one", "two"]) {
		db.run("INSERT INTO session_catalog VALUES('/project',?,'session.json',NULL)", sessionId);
		db.run("INSERT INTO session_meta(cwd,session_id,pinned_at) VALUES('/project',?,1)", sessionId);
		db.run("INSERT INTO review_state(cwd,session_id,payload) VALUES('/project',?,'{}')", sessionId);
		db.run("INSERT INTO drafts VALUES(?, '{}',1,1)", `/project\0${sessionId}`);
		db.run("INSERT INTO draft_conflicts VALUES(?,?,'{}',0,1)", sessionId, `/project\0${sessionId}`);
	}
	db.run(
		"CREATE TRIGGER refuse_review_delete BEFORE DELETE ON review_state WHEN old.session_id='one' BEGIN SELECT RAISE(ABORT,'review is busy'); END",
	);
	expect(() => db.deleteSessionData({ cwd: "/project", sessionId: "one" })).toThrow("review is busy");
	for (const table of ["session_catalog", "session_meta", "review_state", "drafts", "draft_conflicts"])
		expect(db.get(`SELECT count(*) AS count FROM ${table}`)).toEqual({ count: 2 });
	db.run("DROP TRIGGER refuse_review_delete");
	db.deleteSessionData({ cwd: "/project", sessionId: "one" });
	for (const table of ["session_catalog", "session_meta", "review_state", "drafts", "draft_conflicts"])
		expect(db.get(`SELECT count(*) AS count FROM ${table}`)).toEqual({ count: 1 });
	expect(db.get("SELECT session_id FROM session_catalog")).toEqual({ session_id: "two" });
});
