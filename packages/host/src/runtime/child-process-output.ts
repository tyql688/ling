import type { DiagnosticCorrelation } from "@ling/contracts/diagnostics";
import { parseStructuredLogLine, writeLogRecord } from "@ling/core/logger";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** A partial line beyond 64 KiB is flushed so hostile child output cannot grow the line buffer forever. */
const MAX_PENDING_LINE_CHARS = 64 * 1_024;

/** Structured lines from a Ling worker keep their fields; any other output is stored verbatim under the
 * worker's process label so extension and npm output stays visible in diagnostics. */
export function forwardChildProcessOutput(
	child: ChildProcess,
	processLabel: string,
	correlation: () => DiagnosticCorrelation | undefined = () => undefined,
): () => void {
	const releases: Array<() => void> = [];
	const deliver = (line: string, level: "info" | "error"): void => {
		const structured = parseStructuredLogLine(line);
		const record = structured
			? { ...structured, process: processLabel }
			: { at: Date.now(), level, process: processLabel, component: "stdio", message: line };
		const extra = correlation();
		writeLogRecord(extra ? { ...record, correlation: { ...extra, ...record.correlation } } : record);
	};
	const pipe = (stream: NodeJS.ReadableStream | null, level: "info" | "error"): void => {
		if (!stream) return;
		const decoder = new StringDecoder("utf8");
		let pending = "";
		const onData = (chunk: Buffer | string): void => {
			pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				if (line.length > 0) deliver(line, level);
				newline = pending.indexOf("\n");
			}
			if (pending.length > MAX_PENDING_LINE_CHARS) {
				deliver(pending, level);
				pending = "";
			}
		};
		const onEnd = (): void => {
			pending += decoder.end();
			if (pending.length > 0) deliver(pending, level);
			pending = "";
		};
		stream.on("data", onData);
		stream.on("end", onEnd);
		releases.push(() => {
			stream.off("data", onData);
			stream.off("end", onEnd);
		});
	};
	pipe(child.stdout, "info");
	pipe(child.stderr, "error");
	child.once("exit", () => {
		for (const release of releases.splice(0)) release();
	});
	return () => {
		for (const release of releases.splice(0)) release();
	};
}
