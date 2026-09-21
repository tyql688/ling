import type { HostApi } from "@ling/contracts/api/host-procedures";
import type { DraftEvent } from "@ling/contracts/draft";
import { createDraftStore } from "@ling/host/domains/data/draft-store";
import { createHostDatabase, type HostDatabase } from "@ling/host/storage/database";
import { createStore } from "jotai/vanilla";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../../test/temporary-directory";
import { createDraftPersistence, draftPersistenceActionsAtom, draftPersistenceStatusAtom } from "./draft-persistence";
import { draftsAtom, EMPTY_DRAFT, persistSessionDraft } from "./drafts";

vi.mock("@renderer/lib/platform", () => ({ isWindows: false }));
const LEGACY = "ling:composer-drafts";
const RECOVERY = "ling:draft-recovery";
const owners: ReturnType<typeof createDraftPersistence>[] = [];
const databases: HostDatabase[] = [];
const roots: string[] = [];
async function host() {
	const root = await temporaryDirectory("shared-drafts");
	roots.push(root);
	const database = createHostDatabase(root);
	databases.push(database);
	const drafts = createDraftStore(database);
	const listeners = new Set<(event: DraftEvent) => void>();
	const publish = (event: DraftEvent) => {
		for (const listener of listeners) listener(event);
	};
	const api: HostApi["draft"] = {
		list: async () => drafts.list(),
		get: async (key) => drafts.get(key),
		write: async (value) => {
			const result = drafts.write(value);
			publish(result.status === "saved" ? { type: "updated", current: result.current } : { type: "conflictsChanged" });
			return result;
		},
		resolveConflict: async (value) => {
			const result = drafts.resolveConflict(value);
			if (result?.status === "saved") publish({ type: "updated", current: result.current });
			publish({ type: "conflictsChanged" });
			return result;
		},
		onChanged(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return { database, drafts, api, listeners };
}
function fixture(api: HostApi["draft"], saved?: unknown, recovery?: unknown) {
	const values = new Map<string, string>();
	if (saved !== undefined) values.set(LEGACY, JSON.stringify(saved));
	if (recovery !== undefined) values.set(RECOVERY, JSON.stringify(recovery));
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: vi.fn((key: string, value: string) => {
			values.set(key, value);
		}),
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
	const store = createStore();
	const owner = createDraftPersistence(store, storage, api);
	owners.push(owner);
	const edit = (key: string, text: string) =>
		store.set(draftsAtom, (drafts) => ({ ...drafts, [key]: { ...EMPTY_DRAFT, text } }));
	return { store, owner, storage, values, edit };
}
afterEach(async () => {
	for (const owner of owners.splice(0)) owner.dispose();
	for (const database of databases.splice(0)) database.dispose();
	vi.useRealTimers();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared draft ownership", () => {
	it("imports legacy text and valid context independently and keeps damaged source data for recovery", async () => {
		const { drafts, api } = await host();
		const { store, owner, values } = fixture(api, {
			legacy: { text: "keep legacy text" },
			positioned: {
				version: 2,
				text: "ab",
				fileReferences: [{ id: "f", scope: "project", path: "a.ts" }],
				contextPositions: [{ kind: "file", id: "f", offset: 1 }],
			},
			damaged: {
				version: 2,
				text: "keep this too",
				fileReferences: [{ id: "bad", scope: "project", path: "a.ts", lineRange: null }],
			},
		});
		await owner.ready;
		expect(drafts.get("legacy").draft?.text).toBe("keep legacy text");
		expect(drafts.get("positioned").draft?.contextPositions).toEqual([{ kind: "file", id: "f", offset: 1 }]);
		expect(store.get(draftsAtom).damaged).toMatchObject({ text: "keep this too", fileReferences: [] });
		expect(store.get(draftPersistenceStatusAtom).restoreFailed).toBe(true);
		expect(values.has(LEGACY)).toBe(true);
		const complete = fixture(api, { acknowledged: { text: "uploaded" } });
		await complete.owner.ready;
		expect(complete.values.has(LEGACY)).toBe(false);
		expect(complete.values.has(RECOVERY)).toBe(false);
	});
	it("checkpoints continuous typing and restores the final unacknowledged edit after disposal", async () => {
		const { api, drafts } = await host();
		const client = fixture(api);
		await client.owner.ready;
		vi.useFakeTimers();
		for (let index = 0; index < 20; index++) {
			client.edit("session", `typed ${index}`);
			await vi.advanceTimersByTimeAsync(300);
		}
		expect(drafts.get("session").draft?.text).toBe("typed 16");
		client.owner.dispose();
		expect(client.values.get(RECOVERY)).toContain("typed 19");
		expect(vi.getTimerCount()).toBe(0);
		const restored = fixture(api, undefined, JSON.parse(client.values.get(RECOVERY)!));
		await restored.owner.ready;
		expect(drafts.get("session").draft?.text).toBe("typed 19");
		expect(restored.values.has(RECOVERY)).toBe(false);
	});
	it("preserves both clients' edits and makes conflict recovery reversible", async () => {
		const { api, drafts } = await host();
		const first = fixture(api),
			second = fixture(api);
		await Promise.all([first.owner.ready, second.owner.ready]);
		first.edit("shared", "first window");
		second.edit("shared", "second window");
		await first.owner.flush();
		await second.owner.flush();
		expect(first.store.get(draftsAtom).shared?.text).toBe("first window");
		expect(second.store.get(draftsAtom).shared?.text).toBe("second window");
		expect(second.store.get(draftPersistenceStatusAtom).localConflicts).toEqual(["shared"]);
		expect(drafts.list().conflicts[0]?.draft.text).toBe("second window");
		await second.store.get(draftPersistenceActionsAtom)!.resolveLocal("shared", "remote");
		expect(second.store.get(draftsAtom).shared?.text).toBe("first window");
		const recovery = drafts.list().conflicts[0]!;
		await second.store.get(draftPersistenceActionsAtom)!.resolveRecovery(recovery.id, "recover");
		expect(drafts.get("shared").draft?.text).toBe("second window");
		expect(drafts.list().conflicts.some((value) => value.draft.text === "first window")).toBe(true);
		expect(first.store.get(draftsAtom).shared?.text).toBe("second window");
	});
	it("fences a delayed save acknowledgement from newer typing and remote revisions", async () => {
		const { api, drafts } = await host();
		let release: (() => void) | undefined;
		const response = new Promise<void>((resolve) => {
			release = resolve;
		});
		let delayed = true;
		const client = fixture({
			...api,
			write: async (request) => {
				const value = await api.write(request);
				if (delayed) await response;
				return value;
			},
		});
		await client.owner.ready;
		client.edit("late", "first edit");
		const writing = client.owner.flush();
		await vi.waitFor(() => expect(drafts.get("late").revision).toBe(1));
		client.edit("late", "newer typing");
		await api.write({
			key: "late",
			baseRevision: 1,
			draft: persistSessionDraft({ ...EMPTY_DRAFT, text: "other window" }),
		});
		delayed = false;
		release!();
		await writing;
		expect(client.store.get(draftsAtom).late?.text).toBe("newer typing");
		await client.owner.flush();
		expect(drafts.get("late").draft?.text).toBe("other window");
		expect(drafts.list().conflicts.some((value) => value.draft.text === "newer typing")).toBe(true);
	});
	it("retains live input and unaffected drafts after a failed write, then retries successfully", async () => {
		const { api, database, drafts } = await host();
		const client = fixture(api);
		await client.owner.ready;
		database.run(
			"CREATE TRIGGER refuse_draft BEFORE INSERT ON drafts WHEN new.key='failed' BEGIN SELECT RAISE(ABORT,'disk unavailable'); END",
		);
		client.edit("failed", "unsent input");
		client.edit("healthy", "independent input");
		await client.owner.flush();
		expect(client.store.get(draftsAtom).failed?.text).toBe("unsent input");
		expect(client.values.get(RECOVERY)).toContain("unsent input");
		expect(drafts.get("healthy").draft?.text).toBe("independent input");
		expect(client.store.get(draftPersistenceStatusAtom).saveError).toContain("disk unavailable");
		database.run("DROP TRIGGER refuse_draft");
		await client.owner.flush();
		expect(drafts.get("failed").draft?.text).toBe("unsent input");
		expect(client.values.has(RECOVERY)).toBe(false);
		expect(client.store.get(draftPersistenceStatusAtom).saveError).toBeNull();
	});
	it("keeps images transient and prevents a deleted session from accepting late writes", async () => {
		const { api, database, drafts } = await host();
		const client = fixture(api);
		await client.owner.ready;
		client.store.set(draftsAtom, {
			session: {
				...EMPTY_DRAFT,
				text: "text only",
				attachments: [{ id: "image", dataUrl: "data:image/png;base64,YQ==", mimeType: "image/png" }],
				contextPositions: [{ kind: "image", id: "image", offset: 0 }],
			},
		});
		await client.owner.flush();
		expect(JSON.stringify(drafts.get("session"))).not.toContain("image");
		await api.write({
			key: "session",
			baseRevision: 1,
			draft: persistSessionDraft({ ...EMPTY_DRAFT, text: "remote" }),
		});
		expect(client.store.get(draftsAtom).session?.attachments).toHaveLength(1);
		database.deleteSessionData({ cwd: "/project", sessionId: "deleted" });
		client.edit("/project\0deleted", "late typing");
		await client.owner.flush();
		expect(drafts.get("/project\0deleted").draft).toBeNull();
		expect(client.store.get(draftsAtom)["/project\0deleted"]?.text).toBe("late typing");
		expect(client.values.get(RECOVERY)).toContain("late typing");
	});
	it("rejects excess retained drafts without evicting input and permits a clear to release capacity", async () => {
		const { api, drafts } = await host();
		for (let index = 0; index < 256; index++)
			drafts.write({
				key: `draft-${index}`,
				baseRevision: 0,
				draft: persistSessionDraft({ ...EMPTY_DRAFT, text: `saved ${index}` }),
			});
		const client = fixture(api);
		await client.owner.ready;
		client.edit("excess", "keep this input");
		await client.owner.flush();
		expect(drafts.list().drafts).toHaveLength(256);
		expect(client.store.get(draftsAtom).excess?.text).toBe("keep this input");
		expect(client.store.get(draftPersistenceStatusAtom).saveError).toContain("storage is full");
		client.store.set(draftsAtom, (current) => {
			const { ["draft-0"]: _removed, ...next } = current;
			return next;
		});
		await client.owner.flush();
		expect(drafts.get("excess").draft?.text).toBe("keep this input");
		expect(drafts.get("draft-1").draft?.text).toBe("saved 1");
	});
	it("returns a complete healthy subset when another persisted draft has an invalid shape", async () => {
		const { api, database, drafts } = await host();
		drafts.write({ key: "healthy", baseRevision: 0, draft: persistSessionDraft({ ...EMPTY_DRAFT, text: "retained" }) });
		database.run("INSERT INTO drafts VALUES('broken','{}',1,1)");
		const snapshot = drafts.list();
		expect(snapshot.drafts).toHaveLength(1);
		expect(snapshot.issues[0]?.key).toBe("broken");
		const client = fixture(api);
		await client.owner.ready;
		expect(client.store.get(draftsAtom).healthy?.text).toBe("retained");
		expect(client.store.get(draftPersistenceStatusAtom).restoreFailed).toBe(true);
		database.run("DELETE FROM drafts WHERE key='broken'");
		await client.store.get(draftPersistenceActionsAtom)!.retry();
		expect(client.store.get(draftPersistenceStatusAtom).restoreFailed).toBe(false);
	});
});
