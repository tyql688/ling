import type { HostApi } from "@ling/contracts/api/host-procedures";
import { editorJsonSchemas } from "@ling/contracts/editor-json-schemas";
import type { UserStateChange, UserStateMutation } from "@ling/contracts/user-state";
import { sessionKey } from "@ling/contracts/session-ref";
import { createUserStateStore } from "@ling/host/domains/data/user-state-store";
import { createHostDatabase, type HostDatabase } from "@ling/host/storage/database";
import { createStore } from "jotai/vanilla";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createUserStatePersistence } from "./persistence";
import {
	mutateUserStateAtom,
	retryUserStateAtom,
	sharedPreferenceAtom,
	userStateAtom,
	userStateStatusAtom,
} from "./state";

const owners: ReturnType<typeof createUserStatePersistence>[] = [];
const databases: HostDatabase[] = [];
const roots: string[] = [];
const ref = { cwd: "/project", sessionId: "test" };
const otherRef = { cwd: "/project", sessionId: "other" };
async function host() {
	const root = await temporaryDirectory("user-state");
	roots.push(root);
	const database = createHostDatabase(root);
	databases.push(database);
	const data = createUserStateStore(database);
	const listeners = new Set<(change: UserStateChange) => void>();
	const publish = (change: UserStateChange) => {
		for (const listener of listeners) listener(change);
		return change;
	};
	database.subscribeSessionDeletion(() => publish({ revision: data.revision(), mutations: null }));
	const api: HostApi["userState"] = {
		get: async () => data.snapshot(),
		update: async (mutations) => publish(data.update(mutations)),
		importLegacy: async (request) => publish(data.importLegacy(request)),
		onChanged: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return { data, database, api };
}
function client(api: HostApi["userState"], initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		get length() {
			return values.size;
		},
	};
	const store = createStore();
	const owner = createUserStatePersistence(store, storage, api);
	owners.push(owner);
	const edit = (...mutations: UserStateMutation[]) => store.set(mutateUserStateAtom, mutations);
	return { store, owner, values, edit };
}
afterEach(async () => {
	for (const owner of owners.splice(0)) owner.dispose();
	for (const database of databases.splice(0)) database.dispose();
	vi.useRealTimers();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("shared user metadata", () => {
	it("retains independent texture choices on reload and resets only the selected skin", async () => {
		const { api, data } = await host();
		const first = client(api);
		await first.owner.ready;
		const kinds = ["paper", "scanlines", "linen"] as const;
		for (const kind of kinds) {
			first.edit({
				type: "skinScene",
				key: `builtin:${kind}`,
				scene: { scope: "conversation", treatment: { kind, strength: 0.35 } },
			});
		}
		await first.owner.flush();
		const reopened = client(api);
		await reopened.owner.ready;
		for (const kind of kinds) {
			expect(reopened.store.get(userStateAtom).skinScenes[`builtin:${kind}`]).toEqual({
				scope: "conversation",
				treatment: { kind, strength: 0.35 },
			});
		}
		reopened.edit({ type: "skinScene", key: "builtin:paper", scene: null });
		await reopened.owner.flush();
		expect(data.snapshot().state.skinScenes["builtin:paper"]).toBeUndefined();
		expect(first.store.get(userStateAtom).skinScenes["builtin:linen"]).toEqual({
			scope: "conversation",
			treatment: { kind: "linen", strength: 0.35 },
		});
	});

	it("reads retired print-dot choices as pixel dithering while retaining their scope and strength", async () => {
		const { api, data, database } = await host();
		database.run(
			"INSERT INTO ui_state(key,value,revision) VALUES(?,?,1)",
			"user:skinScene:builtin:wuthering-shorekeeper",
			JSON.stringify({ scope: "conversation", treatment: { kind: "halftone", strength: 0.35 } }),
		);
		const reopened = client(api);
		await reopened.owner.ready;
		expect(reopened.store.get(userStateAtom).skinScenes["builtin:wuthering-shorekeeper"]).toEqual({
			scope: "conversation",
			treatment: { kind: "dither", cellSize: 1.5, levels: 4, strength: 0.35 },
		});
		expect(data.snapshot().issues).toEqual([]);
		expect(
			JSON.stringify(editorJsonSchemas().find((entry) => entry.uri === "ling://schemas/skin")!.schema),
		).not.toContain('"halftone"');
	});

	it("persists tab order without reopening closed tabs or displacing another client's additions", async () => {
		const { api, data } = await host();
		const first = client(api),
			second = client(api);
		await Promise.all([first.owner.ready, second.owner.ready]);
		first.edit({ type: "tabs", add: [ref, otherRef], remove: [] });
		await first.owner.flush();
		const third = { cwd: "/another", sessionId: "third" };
		second.edit({ type: "tabs", add: [third], remove: [] });
		await second.owner.flush();
		first.edit({ type: "tabs", add: [], remove: [], order: [otherRef, ref] });
		await first.owner.flush();
		expect(data.snapshot().state.openSessionTabs).toEqual([otherRef, ref, third]);
		second.edit({ type: "tabs", add: [], remove: [ref] });
		await second.owner.flush();
		first.edit({ type: "tabs", add: [], remove: [], order: [ref, otherRef] });
		await first.owner.flush();
		expect(data.snapshot().state.openSessionTabs).toEqual([otherRef, third]);
		const reopened = client(api);
		await reopened.owner.ready;
		expect(reopened.store.get(userStateAtom).openSessionTabs).toEqual([otherRef, third]);
	});

	it("coalesces promotion, reordering and closing before persistence", async () => {
		const { api, data } = await host();
		const first = client(api);
		await first.owner.ready;
		first.edit({ type: "tabs", add: [ref, otherRef], remove: [], order: [ref, otherRef] });
		first.edit({ type: "tabs", add: [], remove: [], order: [otherRef, ref] });
		first.edit({ type: "tabs", add: [], remove: [ref] });
		await first.owner.flush();
		expect(data.snapshot().state.openSessionTabs).toEqual([otherRef]);
	});

	it("merges independent client edits and keeps newer local edits across a delayed acknowledgement", async () => {
		const { api, data } = await host();
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let delayed = true;
		const first = client({
				...api,
				update: async (values) => {
					const result = await api.update(values);
					if (delayed) await barrier;
					return result;
				},
			}),
			second = client(api);
		await Promise.all([first.owner.ready, second.owner.ready]);
		first.edit({ type: "projectName", cwd: ref.cwd, name: "first" }, { type: "tabs", add: [ref], remove: [] });
		const writing = first.owner.flush();
		await vi.waitFor(() => expect(data.snapshot().state.projectDisplayNames[ref.cwd]).toBe("first"));
		first.edit({ type: "projectName", cwd: ref.cwd, name: "newer typing" });
		second.edit({ type: "projectPin", cwd: "/second", pinned: true }, { type: "tabs", add: [otherRef], remove: [] });
		await second.owner.flush();
		expect(first.store.get(userStateAtom).projectDisplayNames[ref.cwd]).toBe("newer typing");
		delayed = false;
		release();
		await writing;
		expect(data.snapshot().state.openSessionTabs).toHaveLength(2);
		expect(data.snapshot().state.openSessionTabs).toEqual(expect.arrayContaining([ref, otherRef]));
		expect(second.store.get(userStateAtom).projectDisplayNames[ref.cwd]).toBe("newer typing");
		expect(data.snapshot().state.pinnedProjectCwds).toEqual(["/second"]);
	});
	it("acknowledges each valid legacy source while retaining damaged bytes and protecting explicit clears", async () => {
		const { api, data } = await host();
		const raw = JSON.stringify({ "/project": "legacy", "/damaged": 7 });
		const first = client(api, {
			"ling:project-display-names": raw,
			"ling:pinned-project-cwds": JSON.stringify(["/project", "/second"]),
			"ling:session-seen-at": JSON.stringify({ [sessionKey(ref)]: -0.25 }),
			"ling:open-session-tabs": JSON.stringify([ref]),
		});
		await first.owner.ready;
		expect(data.snapshot().state.pinnedProjectCwds).toEqual(["/project", "/second"]);
		expect(data.snapshot().state.sessionSeenAt[sessionKey(ref)]).toBe(-0.25);
		expect(first.values.get("ling:project-display-names")).toBe(raw);
		expect(first.values.has("ling:pinned-project-cwds")).toBe(false);
		expect(first.store.get(userStateStatusAtom).issues).toHaveLength(1);
		first.edit(
			{ type: "projectName", cwd: ref.cwd, name: null },
			{ type: "projectPin", cwd: ref.cwd, pinned: false },
			{ type: "tabs", add: [], remove: [ref] },
		);
		await first.owner.flush();
		const second = client(api, {
			"ling:project-display-names": JSON.stringify({ "/project": "old again" }),
			"ling:open-session-tabs": JSON.stringify([ref]),
		});
		await second.owner.ready;
		expect(data.snapshot().state.projectDisplayNames[ref.cwd]).toBeUndefined();
		expect(data.snapshot().state.openSessionTabs).toEqual([]);
		expect(second.values.size).toBe(0);
		first.values.set("ling:project-display-names", JSON.stringify({ "/project": "old", "/damaged": "repaired" }));
		await first.store.get(retryUserStateAtom)!();
		expect(first.values.has("ling:project-display-names")).toBe(false);
		expect(data.snapshot().state.projectDisplayNames["/damaged"]).toBe("repaired");
		expect(first.store.get(userStateStatusAtom).issues).toEqual([]);
	});
	it("keeps failed writes in a recovery journal and restores them after the renderer is replaced", async () => {
		const { api, database, data } = await host();
		const first = client(api);
		await first.owner.ready;
		database.run(
			"CREATE TRIGGER unavailable BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'temporarily unavailable'); END",
		);
		first.edit(
			{ type: "projectName", cwd: ref.cwd, name: "unsaved" },
			{ type: "preference", preference: { key: "sendShortcut", value: "cmd-enter-always" } },
		);
		await first.owner.flush();
		expect(first.store.get(userStateAtom).projectDisplayNames[ref.cwd]).toBe("unsaved");
		expect(first.store.get(userStateStatusAtom).error).not.toBeNull();
		expect(data.snapshot().state.preferences.sendShortcut).toBe("cmd-enter-always");
		const recovery = first.values.get("ling:user-state-recovery")!;
		first.owner.dispose();
		database.run("DROP TRIGGER unavailable");
		const second = client(api, { "ling:user-state-recovery": recovery });
		await second.owner.ready;
		expect(data.snapshot().state.projectDisplayNames[ref.cwd]).toBe("unsaved");
		expect(second.values.has("ling:user-state-recovery")).toBe(false);
	});
	it("removes session metadata atomically and refuses delayed recreation without damaging other sessions", async () => {
		const { api, database, data } = await host();
		const first = client(api);
		await first.owner.ready;
		const mark = { status: "modified", additions: 1, deletions: 0, contentTag: "fingerprint" };
		first.edit(
			{ type: "tabs", add: [ref, otherRef], remove: [] },
			{ type: "sessionSeen", ref, seenAt: 10 },
			{ type: "reviewMark", ref, path: "__proto__", mark },
			{ type: "reviewMark", ref: otherRef, path: "file", mark },
		);
		await first.owner.flush();
		expect(Object.hasOwn(data.snapshot().state.reviewed[sessionKey(ref)]!, "__proto__")).toBe(true);
		database.run(
			"CREATE TRIGGER failed_delete BEFORE DELETE ON review_state BEGIN SELECT RAISE(ABORT,'delete interrupted'); END",
		);
		expect(() => database.deleteSessionData(ref)).toThrow("delete interrupted");
		expect(data.snapshot().state.openSessionTabs).toEqual([ref, otherRef]);
		database.run("DROP TRIGGER failed_delete");
		database.deleteSessionData(ref);
		await vi.waitFor(() => expect(first.store.get(userStateAtom).openSessionTabs).toEqual([otherRef]));
		first.edit(
			{ type: "tabs", add: [ref], remove: [] },
			{ type: "reviewMark", ref, path: "late", mark },
			{ type: "sessionSeen", ref, seenAt: 20 },
		);
		await first.owner.flush();
		const current = data.snapshot().state;
		expect(current.reviewed[sessionKey(ref)]).toBeUndefined();
		expect(current.reviewed[sessionKey(otherRef)]?.file).toEqual(mark);
		expect(current.sessionSeenAt[sessionKey(ref)]).toBeUndefined();
		expect(current.openSessionTabs).toEqual([otherRef]);
	});
	it("preserves future legacy metadata and source bytes while reading already shared data", async () => {
		const { api, data } = await host();
		data.update([{ type: "projectName", cwd: ref.cwd, name: "already shared" }]);
		const saved = {
			"ling:preferences-meta": JSON.stringify({ schema: "ling/renderer-preferences", version: 2 }),
			"ling:project-display-names": JSON.stringify({ "/legacy": "future source" }),
		};
		const first = client(api, saved);
		await first.owner.ready;
		expect(first.values.get("ling:preferences-meta")).toBe(saved["ling:preferences-meta"]);
		expect(first.values.get("ling:project-display-names")).toBe(saved["ling:project-display-names"]);
		expect(first.store.get(userStateAtom).projectDisplayNames[ref.cwd]).toBe("already shared");
		expect(first.store.get(userStateStatusAtom).issues).toHaveLength(1);
	});
	it("keeps Markdown disabled by default and shares explicitly saved behavior preferences", async () => {
		const { api } = await host();
		const first = client(api),
			second = client(api);
		await Promise.all([first.owner.ready, second.owner.ready]);
		const mode = sharedPreferenceAtom("composerEditorMode", "plain");
		expect(first.store.get(mode)).toBe("plain");
		first.store.set(mode, "markdown");
		await first.owner.flush();
		expect(second.store.get(mode)).toBe("markdown");
		first.store.set(mode, "plain");
		await first.owner.flush();
		expect(second.store.get(mode)).toBe("plain");
	});
});
