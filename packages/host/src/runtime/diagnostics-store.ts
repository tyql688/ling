import {
	DIAGNOSTIC_LOG_PAGE_MAX,
	type DiagnosticCorrelation,
	type DiagnosticLogPage,
	type DiagnosticLogQuery,
	type DiagnosticLogRecord,
} from "@ling/contracts/diagnostics";
import { addLogSink, createLogger, type LogRecord } from "@ling/core/logger";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const log = createLogger("diagnostics-store");
const FLUSH_INTERVAL_MS = 250;
/** Lines buffered while the flush timer is pending; a runaway logger drops its oldest lines. */
const BUFFER_CAPACITY = 5_000;
const RETENTION_DAYS = 14;
const RETENTION_ROWS = 200_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const DEFAULT_PAGE = 200;

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS logs(
	id INTEGER PRIMARY KEY,
	at INTEGER NOT NULL,
	level TEXT NOT NULL,
	process TEXT NOT NULL,
	component TEXT NOT NULL,
	message TEXT NOT NULL,
	session_id TEXT,
	request_id TEXT,
	runtime_id TEXT,
	code TEXT,
	generation INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS logs_at ON logs(at);
CREATE INDEX IF NOT EXISTS logs_session ON logs(session_id, id);
`;

const rowSchema = z.object({
	id: z.number().int(),
	at: z.number().int(),
	level: z.enum(["info", "warn", "error"]),
	process: z.string(),
	component: z.string(),
	message: z.string(),
	session_id: z.string().nullable(),
	request_id: z.string().nullable(),
	runtime_id: z.string().nullable(),
	code: z.string().nullable(),
	generation: z.number().int().nullable(),
});
const labelSchema = z.object({ label: z.string() });

export interface DiagnosticsStore {
	readonly path: string;
	query(query: DiagnosticLogQuery): DiagnosticLogPage;
	flush(): void;
	dispose(): void;
}

function toRecord(row: z.infer<typeof rowSchema>): DiagnosticLogRecord {
	const correlation: DiagnosticCorrelation = {};
	if (row.session_id !== null) correlation.sessionId = row.session_id;
	if (row.request_id !== null) correlation.requestId = row.request_id;
	if (row.runtime_id !== null) correlation.runtimeId = row.runtime_id;
	if (row.code !== null) correlation.code = row.code;
	if (row.generation !== null) correlation.generation = row.generation;
	return {
		id: row.id,
		at: row.at,
		level: row.level,
		process: row.process,
		component: row.component,
		message: row.message,
		...(Object.keys(correlation).length > 0 ? { correlation } : {}),
	};
}

/** Opens the Host diagnostics database and mirrors every logger line into it. The store never throws
 * into the logger: an unavailable database leaves console output as the only sink. */
export function createDiagnosticsStore(logsDirectory: string): DiagnosticsStore {
	const path = join(logsDirectory, "ling-diagnostics.sqlite");
	mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
	const database = new DatabaseSync(path, { allowExtension: false });
	database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
	database.exec(CREATE_SCHEMA);
	const insert = database.prepare(
		"INSERT INTO logs(at, level, process, component, message, session_id, request_id, runtime_id, code, generation) VALUES(?,?,?,?,?,?,?,?,?,?)",
	);
	let buffer: LogRecord[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	function flush(): void {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = null;
		if (buffer.length === 0 || disposed) return;
		const pending = buffer;
		buffer = [];
		try {
			database.exec("BEGIN");
			for (const record of pending) {
				const correlation = record.correlation ?? {};
				insert.run(
					record.at,
					record.level,
					record.process,
					record.component,
					record.message,
					correlation.sessionId ?? null,
					correlation.requestId ?? null,
					correlation.runtimeId ?? null,
					correlation.code ?? null,
					correlation.generation ?? null,
				);
			}
			database.exec("COMMIT");
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// The failed transaction is already reported below.
			}
			process.stderr.write(
				`[host/diagnostics-store] failed to persist ${pending.length} log lines: ${String(error)}\n`,
			);
		}
	}

	function prune(): void {
		try {
			database.prepare("DELETE FROM logs WHERE at < ?").run(Date.now() - RETENTION_DAYS * 86_400_000);
			database
				.prepare("DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)")
				.run(RETENTION_ROWS);
		} catch (error) {
			log.warn("diagnostics retention failed:", error);
		}
	}

	const unsubscribe = addLogSink((record) => {
		if (disposed) return;
		if (buffer.length >= BUFFER_CAPACITY) buffer.shift();
		buffer.push(record);
		flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
		flushTimer.unref();
	});
	const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
	pruneTimer.unref();
	prune();

	const dispose = (): void => {
		if (disposed) return;
		unsubscribe();
		flush();
		disposed = true;
		clearInterval(pruneTimer);
		process.off("exit", dispose);
		try {
			database.close();
		} catch (error) {
			process.stderr.write(`[host/diagnostics-store] failed to close: ${String(error)}\n`);
		}
	};
	process.once("exit", dispose);

	return {
		path,
		flush,
		dispose,
		query(query) {
			flush();
			const conditions: string[] = [];
			const parameters: Array<string | number> = [];
			if (query.beforeId !== undefined) {
				conditions.push("id < ?");
				parameters.push(query.beforeId);
			}
			if (query.afterId !== undefined) {
				conditions.push("id > ?");
				parameters.push(query.afterId);
			}
			if (query.levels && query.levels.length > 0) {
				conditions.push(`level IN (${query.levels.map(() => "?").join(",")})`);
				parameters.push(...query.levels);
			}
			if (query.process) {
				conditions.push("process = ?");
				parameters.push(query.process);
			}
			if (query.component) {
				conditions.push("component = ?");
				parameters.push(query.component);
			}
			if (query.sessionId) {
				conditions.push("session_id = ?");
				parameters.push(query.sessionId);
			}
			if (query.text) {
				conditions.push("message LIKE ? ESCAPE '\\'");
				parameters.push(`%${query.text.replace(/[\\%_]/g, "\\$&")}%`);
			}
			const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const order = query.afterId !== undefined ? "ASC" : "DESC";
			const limit = Math.min(query.limit ?? DEFAULT_PAGE, DIAGNOSTIC_LOG_PAGE_MAX);
			const rows = database
				.prepare(`SELECT * FROM logs ${where} ORDER BY id ${order} LIMIT ?`)
				.all(...parameters, limit)
				.map((row) => toRecord(rowSchema.parse(row)));
			const labels = (column: "process" | "component"): string[] =>
				database
					.prepare(`SELECT DISTINCT ${column} AS label FROM logs ORDER BY label`)
					.all()
					.map((row) => labelSchema.parse(row).label);
			return { records: rows, processes: labels("process"), components: labels("component") };
		},
	};
}
