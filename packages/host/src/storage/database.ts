import { openSessionTabsSchema } from "@ling/contracts/user-state";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { DATA_HEALTH_ISSUE_LIMIT, type DataStoreHealth, type DataStoreIssue } from "@ling/contracts/data-store";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";

const log = createLogger("host-database");
/** Ling owns its schema independently of legacy JSON envelope versions. */
const SCHEMA_VERSION = 3;
/** Another Host or a backup may briefly hold the writer lock; bound the synchronous wait. */
const DATABASE_BUSY_TIMEOUT_MS = 2500;
/** Health is a summary, not an unbounded dump of damaged historical files. */
const issueSchema = z.object({ key: z.string(), source: z.string(), message: z.string() });
const importRowSchema = z.object({ state: z.enum(["complete", "failed"]) });
const countSchema = z.object({ count: z.number().int().nonnegative() });

const CREATE_SCHEMA = `
CREATE TABLE schema_version(version INTEGER NOT NULL) STRICT;
INSERT INTO schema_version VALUES(3);
CREATE TABLE legacy_imports(key TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('complete','failed')), message TEXT, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE projects(cwd TEXT PRIMARY KEY, is_open INTEGER NOT NULL DEFAULT 0 CHECK(is_open IN (0,1)), open_order INTEGER NOT NULL DEFAULT 0, display_name TEXT, pinned_at REAL, last_opened_at INTEGER NOT NULL DEFAULT 0, name_revision INTEGER NOT NULL DEFAULT 0, pin_revision INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE session_meta(cwd TEXT NOT NULL, session_id TEXT NOT NULL, pinned_at REAL, archived_at REAL, read_at REAL, fork_source TEXT CHECK(fork_source IS NULL OR json_valid(fork_source)), PRIMARY KEY(cwd,session_id)) STRICT;
CREATE TABLE session_catalog(cwd TEXT NOT NULL, session_id TEXT NOT NULL, session_file_path TEXT NOT NULL, summary TEXT CHECK(summary IS NULL OR json_valid(summary)), PRIMARY KEY(cwd,session_id)) STRICT;
CREATE TABLE drafts(key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE draft_conflicts(id TEXT PRIMARY KEY, draft_key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), base_revision INTEGER NOT NULL, saved_at INTEGER NOT NULL) STRICT;
CREATE INDEX draft_conflicts_key ON draft_conflicts(draft_key,saved_at);
CREATE TABLE ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)), revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE composer_history(id INTEGER PRIMARY KEY, cwd TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE INDEX composer_history_recent ON composer_history(created_at DESC);
CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))) STRICT;
CREATE TABLE review_state(cwd TEXT NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), reviewed TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(reviewed)), reviewed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(cwd,session_id)) STRICT;
CREATE TABLE cleanup_retries(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE deleted_sessions(key TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL) STRICT;
`;

interface LegacyImport<Value> {
	key: string;
	source: string;
	read(): Value;
	publish(value: Value): void;
}

/** A single connection owns synchronous transactions. Domain owners validate rows and historical formats. */
export function createHostDatabase(userDataDirectory: string) {
	const path = join(userDataDirectory, "ling.sqlite");
	let connection: DatabaseSync | null = null;
	let failure: Error | null = null;
	let disposed = false;
	let transactionDepth = 0;
	const listeners = new Set<() => void>();
	const deletionListeners = new Set<() => void>();
	let deletionPending = false;
	let notificationPending = false;

	function changed() {
		if (notificationPending || disposed) return;
		notificationPending = true;
		queueMicrotask(() => {
			notificationPending = false;
			if (disposed) return;
			for (const listener of listeners) {
				try {
					listener();
				} catch (error) {
					log.error("Database health listener failed:", error);
				}
			}
		});
	}
	function failed(error: unknown) {
		failure = toError(error);
		log.error("Host database is unavailable:", failure);
		changed();
	}
	function requireConnection() {
		if (disposed) throw new Error("Host database is closed");
		if (!connection) throw new Error("Ling data is unavailable", { cause: failure });
		return connection;
	}
	function open() {
		if (disposed) throw new Error("Host database is closed");
		let candidate: DatabaseSync | null = null;
		try {
			mkdirSync(userDataDirectory, { recursive: true, mode: 0o700 });
			closeSync(openSync(path, "a", 0o600));
			candidate = new DatabaseSync(path, {
				timeout: DATABASE_BUSY_TIMEOUT_MS,
				enableForeignKeyConstraints: true,
				allowExtension: false,
			});
			const exists = candidate
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
				.get();
			if (exists) {
				const versions = candidate.prepare("SELECT version FROM schema_version").all();
				if (versions.length !== 1) throw new Error("Ling database version marker is invalid");
				const row = z.object({ version: z.number().int() }).parse(versions[0]);
				if (row.version < 1 || row.version > SCHEMA_VERSION)
					throw new Error(`Unsupported Ling database version: ${row.version}`);
				const migrations: Record<number, string> = {
					1: "CREATE TABLE deleted_sessions(key TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL) STRICT",
					2: `ALTER TABLE projects ADD COLUMN name_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN pin_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_state ADD COLUMN reviewed TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(reviewed));
ALTER TABLE review_state ADD COLUMN reviewed_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE session_meta_migrated(cwd TEXT NOT NULL, session_id TEXT NOT NULL, pinned_at REAL, archived_at REAL, read_at REAL, fork_source TEXT CHECK(fork_source IS NULL OR json_valid(fork_source)), PRIMARY KEY(cwd,session_id)) STRICT;
INSERT INTO session_meta_migrated SELECT cwd,session_id,pinned_at,archived_at,read_at,fork_source FROM session_meta;
DROP TABLE session_meta;
ALTER TABLE session_meta_migrated RENAME TO session_meta;`,
				};
				for (let version = row.version; version < SCHEMA_VERSION; version++) {
					const migration = migrations[version];
					if (!migration) throw new Error(`Missing Ling database migration from version ${version}`);
					candidate.exec("BEGIN IMMEDIATE");
					try {
						candidate.exec(migration);
						candidate.prepare("UPDATE schema_version SET version=?").run(version + 1);
						candidate.exec("COMMIT");
					} catch (error) {
						try {
							candidate.exec("ROLLBACK");
						} catch (rollback) {
							throw new AggregateError([toError(error), toError(rollback)], "Database migration and rollback failed");
						}
						throw error;
					}
				}
			} else {
				const { count } = countSchema.parse(
					candidate
						.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
						.get(),
				);
				if (count > 0) throw new Error("The database is missing its Ling schema marker");
				candidate.exec("BEGIN IMMEDIATE");
				try {
					candidate.exec(CREATE_SCHEMA);
					candidate.exec("COMMIT");
				} catch (error) {
					try {
						candidate.exec("ROLLBACK");
					} catch (rollback) {
						throw new AggregateError(
							[toError(error), toError(rollback)],
							"Database initialization and rollback failed",
						);
					}
					throw error;
				}
			}
			candidate.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
			connection = candidate;
			failure = null;
			changed();
		} catch (error) {
			let failure = toError(error);
			try {
				candidate?.close();
			} catch (cleanup) {
				failure = new AggregateError([failure, toError(cleanup)], "Database open and cleanup failed");
			}
			failed(failure);
		}
	}
	function execute<Result>(operation: (database: DatabaseSync) => Result): Result {
		const database = requireConnection();
		try {
			return operation(database);
		} catch (error) {
			failed(error);
			throw error;
		}
	}
	function run(sql: string, ...values: SQLInputValue[]) {
		return execute((database) => database.prepare(sql).run(...values));
	}
	function get(sql: string, ...values: SQLInputValue[]) {
		return execute((database) => database.prepare(sql).get(...values));
	}
	function all(sql: string, ...values: SQLInputValue[]) {
		return execute((database) => database.prepare(sql).all(...values));
	}
	function transaction<Result>(
		operation: () => Result & (Result extends PromiseLike<unknown> ? never : unknown),
	): Result {
		const database = requireConnection();
		// Nested owners share the outer commit; a synchronous callback cannot yield admission to another request.
		if (transactionDepth > 0) return operation();
		execute((database) => database.exec("BEGIN IMMEDIATE"));
		transactionDepth++;
		try {
			const value = operation();
			if (value instanceof Promise) throw new Error("Database transactions must not await asynchronous work");
			execute((database) => database.exec("COMMIT"));
			if (deletionPending)
				queueMicrotask(() => {
					if (disposed) return;
					for (const listener of deletionListeners) {
						try {
							listener();
						} catch (error) {
							log.error("Session data deletion listener failed:", error);
						}
					}
				});
			return value;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch (rollback) {
				failed(rollback);
				throw new AggregateError([toError(error), toError(rollback)], "Database transaction and rollback failed");
			}
			throw error;
		} finally {
			transactionDepth--;
			deletionPending = false;
		}
	}
	function markImported(key: string, source: string) {
		run(
			"INSERT INTO legacy_imports(key,source,state,message,updated_at) VALUES(?,?,'complete',NULL,?) ON CONFLICT(key) DO UPDATE SET state='complete',message=NULL,updated_at=excluded.updated_at",
			key,
			source,
			Date.now(),
		);
		changed();
	}
	function importLegacy<Value>(spec: LegacyImport<Value>) {
		const row = get("SELECT state FROM legacy_imports WHERE key=?", spec.key);
		if (row && importRowSchema.parse(row).state === "complete") return;
		try {
			const value = spec.read();
			transaction(() => {
				spec.publish(value);
				markImported(spec.key, spec.source);
			});
			changed();
		} catch (error) {
			try {
				// Keep all historical bytes untouched; only a successful import and its marker commit together.
				run(
					"INSERT INTO legacy_imports(key,source,state,message,updated_at) VALUES(?,?,'failed',?,?) ON CONFLICT(key) DO UPDATE SET state='failed',message=excluded.message,updated_at=excluded.updated_at",
					spec.key,
					spec.source,
					toError(error).message.slice(0, 2048),
					Date.now(),
				);
				changed();
			} catch (journalError) {
				throw new AggregateError(
					[toError(error), toError(journalError)],
					"Legacy import and failure journal both failed",
				);
			}
			throw error;
		}
	}
	function health(): DataStoreHealth {
		if (disposed || !connection || failure)
			return {
				status: "unavailable",
				path,
				message: failure?.message ?? "Ling data is closed",
				issues: [],
				omittedIssues: 0,
			};
		try {
			const issues: DataStoreIssue[] = all(
				"SELECT key,source,message FROM legacy_imports WHERE state='failed' ORDER BY updated_at DESC LIMIT ?",
				DATA_HEALTH_ISSUE_LIMIT,
			).map((row) => issueSchema.parse(row));
			const { count } = countSchema.parse(get("SELECT count(*) AS count FROM legacy_imports WHERE state='failed'"));
			return {
				status: count > 0 ? "degraded" : "ready",
				path,
				message: null,
				issues,
				omittedIssues: Math.max(0, count - issues.length),
			};
		} catch (error) {
			return { status: "unavailable", path, message: toError(error).message, issues: [], omittedIssues: 0 };
		}
	}
	open();
	return {
		path,
		run,
		get,
		all,
		transaction,
		importLegacy,
		markImported,
		health,
		deleteSessionData(ref: SessionRef) {
			transaction(() => {
				for (const table of ["session_catalog", "session_meta", "review_state"])
					run(`DELETE FROM ${table} WHERE cwd=? AND session_id=?`, ref.cwd, ref.sessionId);
				const key = sessionKey(ref);
				run("DELETE FROM drafts WHERE key=?", key);
				run("DELETE FROM draft_conflicts WHERE draft_key=?", key);
				run("INSERT INTO deleted_sessions(key,deleted_at) VALUES(?,?) ON CONFLICT(key) DO NOTHING", key, Date.now());
				const tabs = get("SELECT value FROM ui_state WHERE key='user:tabs'");
				if (tabs !== undefined) {
					const refs = openSessionTabsSchema.parse(JSON.parse(z.string().parse(tabs.value)));
					run(
						"UPDATE ui_state SET value=?,revision=revision+1 WHERE key='user:tabs'",
						JSON.stringify(refs.filter((ref) => sessionKey(ref) !== key)),
					);
				}
				run(
					"INSERT INTO ui_state(key,value,revision) VALUES('user:revision','null',1) ON CONFLICT(key) DO UPDATE SET revision=revision+1",
				);
				deletionPending = true;
			});
		},
		isSessionDeleted(key: string) {
			return get("SELECT key FROM deleted_sessions WHERE key=?", key) !== undefined;
		},

		subscribeSessionDeletion(listener: () => void) {
			deletionListeners.add(listener);
			return () => {
				deletionListeners.delete(listener);
			};
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		retry() {
			if (disposed) throw new Error("Host database is closed");
			if (!connection) open();
			else {
				try {
					const result = connection.prepare("PRAGMA quick_check").get();
					if (result?.quick_check !== "ok") throw new Error("Ling database integrity check failed");
					failure = null;
					changed();
				} catch (error) {
					failed(error);
				}
			}
			return health();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			deletionListeners.clear();
			const owned = connection;
			connection = null;
			owned?.close();
		},
	};
}
export type HostDatabase = ReturnType<typeof createHostDatabase>;
