import { portableAbsolutePathSchema } from "@ling/contracts/path-validation";
import {
	applyUserStateMutation,
	emptyUserState,
	openSessionTabsSchema,
	retainReviewedProgress,
	REVIEWED_SESSION_MAX_ITEMS,
	reviewedMapSchema,
	SESSION_SEEN_MAX_ITEMS,
	sharedPreferenceSchema,
	skinSceneOverrideSchema,
	skinSceneOverridesSchema,
	skinPreferenceSchema,
	USER_PROJECT_MAX_ITEMS,
	type UserStateChange,
	type UserStateImport,
	type UserStateMutation,
	type UserStateSnapshot,
} from "@ling/contracts/user-state";
import { sessionKey, sessionRefSchema } from "@ling/contracts/session-ref";
import { toError } from "@ling/core/ling-error";
import { z } from "zod";
import type { HostDatabase } from "../../storage/database";

const REVISION_KEY = "user:revision";
const TABS_KEY = "user:tabs";
const LAST_PROJECT_KEY = "user:lastProject";
const SCOPE_KEY = "user:sidebarScope";
const PREFERENCE_PREFIX = "user:preference:";
const SCENE_PREFIX = "user:skinScene:";
/** These are the preexisting project preference budgets; SQL publication must not grow them without limit. */
const PROJECT_PREFERENCE_MAX_BYTES = 1024 * 1024;
/** Match the previous seen-marker cache budget and keep the shared snapshot below the transport frame bound. */
const SEEN_MAX_BYTES = 1_900_000;
function retainSeenRows(rows: ReturnType<HostDatabase["all"]>) {
	let bytes = 2;
	return rows.filter((row) => {
		const seen = seenRow.parse(row);
		const size = Buffer.byteLength(JSON.stringify(sessionKey(seen))) + String(seen.seenAt).length + 2;
		if (bytes + size > SEEN_MAX_BYTES) return false;
		bytes += size;
		return true;
	});
}
const pathSchema = portableAbsolutePathSchema("Stored project path");
const tabsSchema = openSessionTabsSchema;
const valueRow = z.object({ value: z.string() });
const revisionRow = z.object({ revision: z.number().int().positive() });
const projectRow = z.object({
	cwd: pathSchema,
	display_name: z.string().min(1).max(PROJECT_PREFERENCE_MAX_BYTES).nullable(),
	pinned_at: z.number().nullable(),
});
const seenRow = sessionRefSchema.extend({ seenAt: z.number() });

/** Owns shared user metadata. Row-level operations preserve concurrent changes to unrelated entities. */
export function createUserStateStore(database: HostDatabase) {
	function revision() {
		const row = database.get("SELECT revision FROM ui_state WHERE key=?", REVISION_KEY);
		return row === undefined ? 0 : revisionRow.parse(row).revision;
	}
	function readValue(key: string): unknown {
		const row = database.get("SELECT value FROM ui_state WHERE key=?", key);
		return row === undefined ? undefined : JSON.parse(valueRow.parse(row).value);
	}
	function writeValue(key: string, value: unknown, nextRevision: number) {
		database.run(
			"INSERT INTO ui_state(key,value,revision) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=excluded.revision",
			key,
			JSON.stringify(value),
			nextRevision,
		);
	}
	function snapshot(): UserStateSnapshot {
		const result: UserStateSnapshot = { revision: revision(), state: emptyUserState(), issues: [] };
		function read(key: string, operation: () => void) {
			try {
				operation();
			} catch (error) {
				result.issues.push({ key, message: toError(error).message });
			}
		}
		const projects = database.all(
			"SELECT cwd,display_name,pinned_at FROM projects WHERE display_name IS NOT NULL OR pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT ?",
			USER_PROJECT_MAX_ITEMS + 1,
		);
		if (projects.length > USER_PROJECT_MAX_ITEMS)
			result.issues.push({ key: "projects", message: "Stored project preferences exceed their entry budget" });
		let pinnedBytes = 2,
			namedBytes = 2;
		for (const row of projects.slice(0, USER_PROJECT_MAX_ITEMS))
			read(String(row.cwd), () => {
				const project = projectRow.parse(row);
				if (project.pinned_at !== null) {
					const bytes = Buffer.byteLength(JSON.stringify(project.cwd)) + 1;
					if (pinnedBytes + bytes > PROJECT_PREFERENCE_MAX_BYTES)
						throw new Error("Stored project pins exceed their byte budget");
					pinnedBytes += bytes;
					result.state.pinnedProjectCwds.push(project.cwd);
				}
				if (project.display_name !== null) {
					const bytes =
						Buffer.byteLength(JSON.stringify(project.cwd)) +
						Buffer.byteLength(JSON.stringify(project.display_name)) +
						2;
					if (namedBytes + bytes > PROJECT_PREFERENCE_MAX_BYTES)
						throw new Error("Stored project names exceed their byte budget");
					namedBytes += bytes;
					result.state.projectDisplayNames[project.cwd] = project.display_name;
				}
			});
		for (const row of database.all(
			"SELECT cwd,session_id AS sessionId,read_at AS seenAt FROM session_meta WHERE read_at IS NOT NULL ORDER BY read_at DESC LIMIT ?",
			SESSION_SEEN_MAX_ITEMS,
		))
			read(`${String(row.cwd)} / ${String(row.sessionId)}`, () => {
				const seen = seenRow.parse(row);
				result.state.sessionSeenAt[sessionKey(seen)] = seen.seenAt;
			});
		read(TABS_KEY, () => {
			const value = readValue(TABS_KEY);
			if (value !== undefined) result.state.openSessionTabs = tabsSchema.parse(value);
		});
		read(LAST_PROJECT_KEY, () => {
			const value = readValue(LAST_PROJECT_KEY);
			if (value !== undefined) result.state.lastConversationCwd = pathSchema.nullable().parse(value);
		});
		read(SCOPE_KEY, () => {
			const value = readValue(SCOPE_KEY);
			if (value !== undefined) result.state.sidebarProjectScope = pathSchema.nullable().parse(value);
		});
		for (const row of database.all("SELECT key,value FROM ui_state WHERE key GLOB ?", PREFERENCE_PREFIX + "*"))
			read(String(row.key), () => {
				const key = z.string().parse(row.key).slice(PREFERENCE_PREFIX.length);
				const preference = sharedPreferenceSchema.parse({ key, value: JSON.parse(valueRow.parse(row).value) });
				result.state = applyUserStateMutation(result.state, { type: "preference", preference });
			});
		for (const row of database.all("SELECT key,value FROM ui_state WHERE key GLOB ?", SCENE_PREFIX + "*"))
			read(String(row.key), () => {
				const key = skinPreferenceSchema.parse(z.string().parse(row.key).slice(SCENE_PREFIX.length));
				const scene = skinSceneOverrideSchema.nullable().parse(JSON.parse(valueRow.parse(row).value));
				if (scene !== null) result.state.skinScenes[key] = scene;
			});
		for (const row of database
			.all(
				"SELECT cwd,session_id AS sessionId,reviewed FROM review_state WHERE reviewed!='{}' ORDER BY reviewed_at DESC,rowid DESC LIMIT ?",
				REVIEWED_SESSION_MAX_ITEMS,
			)
			.reverse())
			read(`${String(row.cwd)} / ${String(row.sessionId)}`, () => {
				const ref = sessionRefSchema.parse({ cwd: row.cwd, sessionId: row.sessionId });
				result.state.reviewed[sessionKey(ref)] = reviewedMapSchema.parse(JSON.parse(z.string().parse(row.reviewed)));
			});
		const seenRows = Object.entries(result.state.sessionSeenAt).map(([key, seenAt]) => {
			const separator = key.indexOf("\0");
			return { cwd: key.slice(0, separator), sessionId: key.slice(separator + 1), seenAt };
		});
		result.state.sessionSeenAt = Object.fromEntries(
			retainSeenRows(seenRows).map((row) => {
				const seen = seenRow.parse(row);
				return [sessionKey(seen), seen.seenAt];
			}),
		);
		result.state.reviewed = retainReviewedProgress(result.state.reviewed);
		return result;
	}
	function projectBudget() {
		const rows = database
			.all(
				"SELECT cwd,display_name,pinned_at FROM projects WHERE display_name IS NOT NULL OR pinned_at IS NOT NULL LIMIT ?",
				USER_PROJECT_MAX_ITEMS + 1,
			)
			.map((row) => projectRow.parse(row));
		const names = Object.fromEntries(
			rows.filter((row) => row.display_name !== null).map((row) => [row.cwd, row.display_name]),
		);
		const pins = rows.filter((row) => row.pinned_at !== null).map((row) => row.cwd);
		if (
			rows.length > USER_PROJECT_MAX_ITEMS ||
			Buffer.byteLength(JSON.stringify(names)) > PROJECT_PREFERENCE_MAX_BYTES ||
			Buffer.byteLength(JSON.stringify(pins)) > PROJECT_PREFERENCE_MAX_BYTES
		)
			throw new Error("Project preferences exceed their storage budget");
	}
	function apply(
		mutation: UserStateMutation,
		nextRevision: number,
		importing: boolean,
		reviewedBeforeImport: Set<string>,
	): UserStateMutation | null {
		switch (mutation.type) {
			case "projectPin":
			case "projectName":
				return applyProjectMetadataMutation(database, mutation, nextRevision, importing);
			case "sessionSeen": {
				if (database.isSessionDeleted(sessionKey(mutation.ref))) return null;
				database.run(
					"INSERT INTO session_meta(cwd,session_id,read_at) VALUES(?,?,?) ON CONFLICT(cwd,session_id) DO UPDATE SET read_at=max(COALESCE(session_meta.read_at,excluded.read_at),excluded.read_at)",
					mutation.ref.cwd,
					mutation.ref.sessionId,
					mutation.seenAt,
				);
				database.run(
					"UPDATE session_meta SET read_at=NULL WHERE rowid IN (SELECT rowid FROM session_meta WHERE read_at IS NOT NULL ORDER BY read_at DESC LIMIT -1 OFFSET ?)",
					SESSION_SEEN_MAX_ITEMS,
				);
				break;
			}
			case "tabs": {
				// Only the first historical tab strip initializes shared tabs. A later origin must not reopen explicitly closed tabs.
				const value = readValue(TABS_KEY);
				if (importing && value !== undefined) return null;
				const state = { ...emptyUserState(), openSessionTabs: value === undefined ? [] : tabsSchema.parse(value) };
				const accepted = {
					...mutation,
					add: mutation.add.filter((ref) => !database.isSessionDeleted(sessionKey(ref))),
				};
				writeValue(TABS_KEY, applyUserStateMutation(state, accepted).openSessionTabs, nextRevision);
				return accepted;
			}
			case "lastProject":
			case "sidebarScope": {
				const key = mutation.type === "lastProject" ? LAST_PROJECT_KEY : SCOPE_KEY;
				if (importing && readValue(key) !== undefined) return null;
				writeValue(key, mutation.cwd, nextRevision);
				break;
			}
			case "skinScene": {
				const key = SCENE_PREFIX + mutation.key;
				if (importing && readValue(key) !== undefined) return null;
				writeValue(key, mutation.scene, nextRevision);
				const scenes = database.all("SELECT key,value FROM ui_state WHERE key GLOB ?", SCENE_PREFIX + "*");
				skinSceneOverridesSchema.parse(
					Object.fromEntries(
						scenes.flatMap((row) => {
							const value = JSON.parse(valueRow.parse(row).value);
							return value === null ? [] : [[z.string().parse(row.key).slice(SCENE_PREFIX.length), value]];
						}),
					),
				);
				break;
			}
			case "preference": {
				const key = PREFERENCE_PREFIX + mutation.preference.key;
				if (importing && readValue(key) !== undefined) return null;
				writeValue(key, mutation.preference.value, nextRevision);
				break;
			}
			case "reviewMark": {
				if (database.isSessionDeleted(sessionKey(mutation.ref))) return null;
				const row = database.get(
					"SELECT reviewed FROM review_state WHERE cwd=? AND session_id=?",
					mutation.ref.cwd,
					mutation.ref.sessionId,
				);
				const current = row === undefined ? {} : reviewedMapSchema.parse(JSON.parse(z.string().parse(row.reviewed)));
				// A native reviewed record is authoritative, including an explicit unmark.
				if (importing && reviewedBeforeImport.has(sessionKey(mutation.ref))) return null;
				const next = { ...current };
				if (mutation.mark === null) delete next[mutation.path];
				else Object.defineProperty(next, mutation.path, { value: mutation.mark, enumerable: true, configurable: true });
				reviewedMapSchema.parse(next);
				database.run(
					"INSERT INTO review_state(cwd,session_id,payload,reviewed,reviewed_at) VALUES(?,?,'null',?,?) ON CONFLICT(cwd,session_id) DO UPDATE SET reviewed=excluded.reviewed,reviewed_at=excluded.reviewed_at",
					mutation.ref.cwd,
					mutation.ref.sessionId,
					JSON.stringify(next),
					nextRevision,
				);
				break;
			}
		}
		return mutation;
	}
	function update(mutations: readonly UserStateMutation[], importing = false): UserStateChange {
		return database.transaction(() => {
			const nextRevision = revision() + 1;
			const reviewedBeforeImport = new Set(
				importing
					? database
							.all("SELECT cwd,session_id AS sessionId FROM review_state WHERE reviewed_at>0")
							.map((row) => sessionKey(sessionRefSchema.parse(row)))
					: [],
			);
			let invalidated = false;
			const accepted = mutations.flatMap((mutation) => {
				const value = apply(mutation, nextRevision, importing, reviewedBeforeImport);
				return value === null ? [] : [value];
			});
			if (mutations.some((mutation) => mutation.type === "projectPin" || mutation.type === "projectName"))
				projectBudget();
			if (mutations.some((mutation) => mutation.type === "sessionSeen")) {
				const rows = database.all(
					"SELECT cwd,session_id AS sessionId,read_at AS seenAt FROM session_meta WHERE read_at IS NOT NULL ORDER BY read_at DESC",
				);
				const retained = new Set(retainSeenRows(rows).map((row) => sessionKey(seenRow.parse(row))));
				for (const row of rows) {
					const seen = seenRow.parse(row);
					if (!retained.has(sessionKey(seen))) {
						database.run("UPDATE session_meta SET read_at=NULL WHERE cwd=? AND session_id=?", seen.cwd, seen.sessionId);
						invalidated = true;
					}
				}
			}
			if (mutations.some((mutation) => mutation.type === "reviewMark")) {
				const rows = database.all(
					"SELECT cwd,session_id AS sessionId,reviewed FROM review_state WHERE reviewed!='{}' ORDER BY reviewed_at ASC,rowid ASC",
				);
				const maps = Object.fromEntries(
					rows.map((row) => [
						sessionKey(sessionRefSchema.parse({ cwd: row.cwd, sessionId: row.sessionId })),
						reviewedMapSchema.parse(JSON.parse(z.string().parse(row.reviewed))),
					]),
				);
				const retained = retainReviewedProgress(maps);
				for (const row of rows) {
					const ref = sessionRefSchema.parse({ cwd: row.cwd, sessionId: row.sessionId });
					if (!Object.hasOwn(retained, sessionKey(ref)))
						database.run("UPDATE review_state SET reviewed='{}' WHERE cwd=? AND session_id=?", ref.cwd, ref.sessionId);
				}
			}
			if (accepted.length > 0) writeValue(REVISION_KEY, null, nextRevision);
			return {
				revision: accepted.length === 0 ? nextRevision - 1 : nextRevision,
				mutations: invalidated ? null : accepted,
			};
		});
	}
	function importLegacy(request: UserStateImport): UserStateChange {
		let result: UserStateChange = { revision: revision(), mutations: [] };
		database.importLegacy({
			key: `web:${request.source}:${request.digest}`,
			source: request.source,
			read: () => request.mutations,
			publish: (values) => {
				result = update(values, true);
			},
		});
		return result;
	}
	return { snapshot, revision, update, importLegacy };
}

function applyProjectMetadataMutation(
	database: HostDatabase,
	mutation: Extract<UserStateMutation, { type: "projectPin" | "projectName" }>,
	nextRevision: number,
	importing: boolean,
): UserStateMutation | null {
	switch (mutation.type) {
		case "projectPin": {
			const row = database.get("SELECT pin_revision FROM projects WHERE cwd=?", mutation.cwd);
			if (importing && row !== undefined && z.number().parse(row.pin_revision) > 0) return null;
			// Logical ordering stays newest-first even when several imports share a clock tick.
			const maximum = database.get("SELECT max(pinned_at) AS latest FROM projects");
			const latest = z.object({ latest: z.number().nullable() }).parse(maximum).latest;
			const pinnedAt = mutation.pinned ? Math.max(Date.now(), latest === null ? 0 : latest + 1) : null;
			database.run(
				"INSERT INTO projects(cwd,pinned_at,pin_revision) VALUES(?,?,?) ON CONFLICT(cwd) DO UPDATE SET pinned_at=CASE WHEN excluded.pinned_at IS NULL THEN NULL ELSE COALESCE(projects.pinned_at,excluded.pinned_at) END,pin_revision=excluded.pin_revision",
				mutation.cwd,
				pinnedAt,
				nextRevision,
			);
			break;
		}

		case "projectName": {
			const row = database.get("SELECT name_revision FROM projects WHERE cwd=?", mutation.cwd);
			if (importing && row !== undefined && z.number().parse(row.name_revision) > 0) return null;
			database.run(
				"INSERT INTO projects(cwd,display_name,name_revision) VALUES(?,?,?) ON CONFLICT(cwd) DO UPDATE SET display_name=excluded.display_name,name_revision=excluded.name_revision",
				mutation.cwd,
				mutation.name,
				nextRevision,
			);
			break;
		}
	}
	return mutation;
}
