import {
	DRAFT_CONFLICT_MAX_ITEMS,
	DRAFT_STORE_MAX_CHARS,
	DRAFT_STORE_MAX_ITEMS,
	persistedDraftSchema,
	type DraftConflict,
	type DraftSnapshot,
	type PersistedDraft,
	type ResolveDraftConflict,
	type StoredDraft,
	type WriteDraft,
	type WriteDraftResult,
} from "@ling/contracts/draft";
import { requestCancelled, toError } from "@ling/core/ling-error";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HostDatabase } from "../../storage/database";

const storedRow = z.object({
	key: z.string(),
	payload: z.string(),
	revision: z.number().int().positive(),
	updated_at: z.number().int().nonnegative(),
});
const conflictRow = z.object({
	id: z.string(),
	draft_key: z.string(),
	payload: z.string(),
	base_revision: z.number().int().nonnegative(),
	saved_at: z.number().int().nonnegative(),
});
function readStored(row: unknown): StoredDraft {
	const value = storedRow.parse(row);
	return {
		key: value.key,
		draft: persistedDraftSchema.nullable().parse(JSON.parse(value.payload)),
		revision: value.revision,
		updatedAt: value.updated_at,
	};
}
function readConflict(row: unknown): DraftConflict {
	const value = conflictRow.parse(row);
	return {
		id: value.id,
		key: value.draft_key,
		draft: persistedDraftSchema.parse(JSON.parse(value.payload)),
		baseRevision: value.base_revision,
		savedAt: value.saved_at,
	};
}

/** SQLite serializes compare-and-write; stale clients preserve an explicit recovery version instead of replacing input. */
export function createDraftStore(database: HostDatabase) {
	function get(key: string): StoredDraft {
		const row = database.get("SELECT * FROM drafts WHERE key=?", key);
		// Revision zero denotes a key that has never been written. Clears retain their revision as a tombstone.
		return row === undefined ? { key, draft: null, revision: 0, updatedAt: 0 } : readStored(row);
	}
	function checkBudget(table: "drafts" | "draft_conflicts", limit: number) {
		const rows = database.all(`SELECT payload FROM ${table} WHERE payload!='null' LIMIT ?`, limit + 1);
		if (
			rows.length > limit ||
			rows.reduce((size, row) => size + z.string().parse(row.payload).length, 0) > DRAFT_STORE_MAX_CHARS
		)
			throw new Error("Draft storage is full. Remove a saved draft or recovery version and retry.");
	}
	function retainConflict(key: string, draft: PersistedDraft | null, baseRevision: number): DraftConflict | null {
		// A stale clear must leave another client's input intact, but contains no text to recover itself.
		if (draft === null) return null;
		const payload = JSON.stringify(draft);
		const id = createHash("sha256")
			.update(JSON.stringify([key, baseRevision, payload]))
			.digest("hex");
		database.run(
			"INSERT INTO draft_conflicts(id,draft_key,payload,base_revision,saved_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
			id,
			key,
			payload,
			baseRevision,
			Date.now(),
		);
		checkBudget("draft_conflicts", DRAFT_CONFLICT_MAX_ITEMS);
		return readConflict(database.get("SELECT * FROM draft_conflicts WHERE id=?", id));
	}
	function writeCurrent(key: string, draft: PersistedDraft | null, revision: number): StoredDraft {
		const current = { key, draft, revision, updatedAt: Date.now() };
		database.run(
			"INSERT INTO drafts(key,payload,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at",
			key,
			JSON.stringify(draft),
			revision,
			current.updatedAt,
		);
		checkBudget("drafts", DRAFT_STORE_MAX_ITEMS);
		return current;
	}
	function write(request: WriteDraft): WriteDraftResult {
		return database.transaction(() => {
			if (database.isSessionDeleted(request.key) && request.draft !== null)
				throw requestCancelled("The session was deleted before its draft could be saved.");
			const current = get(request.key);
			if (JSON.stringify(current.draft) === JSON.stringify(request.draft)) return { status: "saved", current };
			if (current.revision !== request.baseRevision)
				return {
					status: "conflict",
					current,
					recovery: retainConflict(request.key, request.draft, request.baseRevision),
				};
			if (request.preservePrevious) retainConflict(current.key, current.draft, current.revision);
			return { status: "saved", current: writeCurrent(request.key, request.draft, current.revision + 1) };
		});
	}
	function list(): DraftSnapshot {
		checkBudget("drafts", DRAFT_STORE_MAX_ITEMS);
		checkBudget("draft_conflicts", DRAFT_CONFLICT_MAX_ITEMS);
		const snapshot: DraftSnapshot = { drafts: [], conflicts: [], issues: [] };
		for (const row of database.all("SELECT * FROM drafts WHERE payload!='null' ORDER BY updated_at")) {
			try {
				snapshot.drafts.push(readStored(row));
			} catch (error) {
				snapshot.issues.push({ key: z.string().parse(row.key), message: toError(error).message });
			}
		}
		for (const row of database.all("SELECT * FROM draft_conflicts ORDER BY saved_at DESC")) {
			try {
				snapshot.conflicts.push(readConflict(row));
			} catch (error) {
				snapshot.issues.push({ key: z.string().parse(row.draft_key), message: toError(error).message });
			}
		}
		return snapshot;
	}
	function resolveConflict(request: ResolveDraftConflict): WriteDraftResult | null {
		return database.transaction(() => {
			const row = database.get("SELECT * FROM draft_conflicts WHERE id=?", request.id);
			if (row === undefined) return null;
			const conflict = readConflict(row);
			const current = get(conflict.key);
			if (request.choice === "discard") {
				database.run("DELETE FROM draft_conflicts WHERE id=?", request.id);
				return null;
			}
			if (current.revision !== request.baseRevision) return { status: "conflict", current, recovery: conflict };
			database.run("DELETE FROM draft_conflicts WHERE id=?", request.id);
			// Choosing a recovery version is reversible: retain the displaced, different draft as well.
			if (JSON.stringify(current.draft) !== JSON.stringify(conflict.draft))
				retainConflict(current.key, current.draft, current.revision);
			return { status: "saved", current: writeCurrent(conflict.key, conflict.draft, current.revision + 1) };
		});
	}
	return { get, list, write, resolveConflict };
}
