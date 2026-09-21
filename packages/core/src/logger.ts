import type { DiagnosticCorrelation, DiagnosticLogLevel, DiagnosticLogRecord } from "@ling/contracts/diagnostics";
import { writeSync } from "node:fs";

/** Truncation cap for a single structured-log message; 1 Ki is enough for a diagnostic sentence — longer bloats IPC/disk logs. */
const STRUCTURED_LOG_MAX_MESSAGE_LENGTH = 1_024;

/** Max length of the component field; 64 covers module names and keeps abnormally long strings from polluting the correlation dimension. */
const MAX_COMPONENT_LENGTH = 64;
/** Max length of a correlation string field; 128 covers requestId/sessionId and keeps overlong tokens out of logs. */
const MAX_CORRELATION_STRING_LENGTH = 128;
/** Max number of keys retained when serializing a cause/context object; more only adds noise and volume. */
const MAX_OBJECT_KEYS = 8;
/** Marker key of one structured line exchanged between Ling processes over stdio. */
const STRUCTURED_LINE_MARKER = "@ling";

interface LingLogger {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	write(level: DiagnosticLogLevel, message: string, correlation?: DiagnosticCorrelation, cause?: unknown): void;
}

/** One emitted line before it receives a store id. `process` is the emitting Ling process label. */
export type LogRecord = Omit<DiagnosticLogRecord, "id">;

function clipDiagnosticText(value: string): string {
	const oneLine = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (oneLine.length <= STRUCTURED_LOG_MAX_MESSAGE_LENGTH) return oneLine;
	return `${oneLine.slice(0, STRUCTURED_LOG_MAX_MESSAGE_LENGTH - 1)}…`;
}

function clipCorrelationString(value: string): string {
	return clipDiagnosticText(value).slice(0, MAX_CORRELATION_STRING_LENGTH);
}

function normalizeComponent(component: string): string {
	const normalized = component.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, MAX_COMPONENT_LENGTH);
	if (!normalized) throw new Error("Logger component must contain a safe character");
	return normalized;
}

function summarizeError(error: Error): string {
	return `${error.name}: ${clipDiagnosticText(error.message)}`;
}

function summarizeObject(value: object): string {
	const name = value.constructor?.name && value.constructor.name !== "Object" ? value.constructor.name : "Object";
	const keys = Object.keys(value)
		.slice(0, MAX_OBJECT_KEYS)
		.map((key) => clipDiagnosticText(key));
	return `[${name}${keys.length > 0 ? ` keys=${keys.join(",")}` : ""}]`;
}

function formatLogArguments(args: readonly unknown[]): string {
	if (args.length === 0) return "(no message)";
	return clipDiagnosticText(
		args
			.map((value, index) => {
				if (value instanceof Error) return summarizeError(value);
				if (typeof value === "string") return index === 0 ? value : "<string omitted>";
				if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
				if (typeof value === "undefined") return "undefined";
				if (typeof value === "bigint") return `${value.toString()}n`;
				if (typeof value === "symbol") return `[Symbol]`;
				if (typeof value === "function") return `[Function]`;
				return summarizeObject(value);
			})
			.join(" "),
	);
}

function normalizeCorrelation(correlation: DiagnosticCorrelation | undefined): DiagnosticCorrelation | undefined {
	if (!correlation) return undefined;
	const normalized: DiagnosticCorrelation = {};
	const stringKeys = [
		"requestId",
		"operationId",
		"ownerId",
		"ownerRevision",
		"sessionId",
		"runtimeId",
		"code",
	] as const;
	for (const key of stringKeys) {
		const value = correlation[key];
		if (value !== undefined) normalized[key] = clipCorrelationString(value);
	}
	const integerKeys = ["generation", "revision", "bytes", "count"] as const;
	for (const key of integerKeys) {
		const value = correlation[key];
		if (value !== undefined && Number.isSafeInteger(value) && value >= 0) normalized[key] = value;
	}
	if (correlation.durationMs !== undefined && Number.isFinite(correlation.durationMs) && correlation.durationMs >= 0) {
		normalized.durationMs = correlation.durationMs;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function correlationSuffix(correlation: DiagnosticCorrelation | undefined): string {
	if (!correlation) return "";
	const parts = Object.entries(correlation).map(([key, value]) => `${key}=${String(value)}`);
	return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

type LogSink = (record: LogRecord) => void;
const sinks = new Set<LogSink>();
let structuredOutput = false;
let processLabel = "host";

/** Every line goes to the console and to each sink; a sink failure never reaches the caller. */
export function addLogSink(sink: LogSink): () => void {
	sinks.add(sink);
	return () => {
		sinks.delete(sink);
	};
}

/** Worker processes print one JSON object per line so the Host can store their records with fields intact. */
export function configureLoggerOutput(options: { process: string; structured: boolean }): void {
	processLabel = normalizeComponent(options.process);
	structuredOutput = options.structured;
}

function formatLogLine(record: LogRecord): string {
	return `[${record.process}/${record.component}] ${record.message}${correlationSuffix(record.correlation)}`;
}

/** Reads one stdio line from another Ling process; returns null for ordinary output. */
export function parseStructuredLogLine(line: string): LogRecord | null {
	if (!line.startsWith(`{"${STRUCTURED_LINE_MARKER}":1,`)) return null;
	try {
		const value = JSON.parse(line) as Partial<LogRecord>;
		if (
			typeof value.at !== "number" ||
			(value.level !== "info" && value.level !== "warn" && value.level !== "error") ||
			typeof value.process !== "string" ||
			typeof value.component !== "string" ||
			typeof value.message !== "string"
		) {
			return null;
		}
		const correlation = normalizeCorrelation(value.correlation);
		return {
			at: value.at,
			level: value.level,
			process: normalizeComponent(value.process),
			component: normalizeComponent(value.component),
			message: clipDiagnosticText(value.message),
			...(correlation === undefined ? {} : { correlation }),
		};
	} catch {
		return null;
	}
}

/** Delivers a record that already carries its process label, such as a line received from a child. */
export function writeLogRecord(record: LogRecord): void {
	try {
		const line = structuredOutput
			? JSON.stringify({ [STRUCTURED_LINE_MARKER]: 1, ...record })
			: `${formatLogLine(record)}`;
		writeSync(structuredOutput || record.level !== "info" ? 2 : 1, `${line}\n`);
	} catch {
		// A revoked terminal must not crash the app.
	}
	for (const sink of sinks) {
		try {
			sink(record);
		} catch {
			// A broken sink must not take the logger down with it.
		}
	}
}

function emit(
	level: DiagnosticLogLevel,
	component: string,
	args: readonly unknown[],
	correlation?: DiagnosticCorrelation,
): void {
	const normalized = normalizeCorrelation(correlation);
	writeLogRecord({
		at: Date.now(),
		level,
		process: processLabel,
		component,
		message: formatLogArguments(args),
		...(normalized === undefined ? {} : { correlation: normalized }),
	});
}

export function createLogger(tag: string): LingLogger {
	const component = normalizeComponent(tag);
	return {
		info: (...args) => emit("info", component, args),
		warn: (...args) => emit("warn", component, args),
		error: (...args) => emit("error", component, args),
		write: (level, message, correlation, cause) =>
			emit(level, component, cause === undefined ? [message] : [message, cause], correlation),
	};
}
