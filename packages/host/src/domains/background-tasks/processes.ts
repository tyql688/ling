import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { BackgroundJob } from "@ling/contracts/background-tasks";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { terminateProcessTree, terminateProcessGroup } from "@ling/node-runtime/process-tree-terminator";
import { toError } from "@ling/core/ling-error";
import { sanitizeChildProcessEnvironment } from "../../runtime/child-process-environment";

interface BackgroundProcess extends Omit<BackgroundJob, "status"> {
	status: "running" | "stopping" | "completed" | "failed" | "cancelled";
}

const RETAINED_BYTES = 2 * 1_048_576;
const READ_BYTES = 65_536;

/** Reads a window of retained output that begins at byte `base`, never splitting a UTF-8 sequence. */
export function readOutputWindow(bytes: Buffer, base: number, offset: number) {
	let start = Math.min(Math.max(0, offset - base), bytes.length);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	let end = Math.min(start + READ_BYTES, bytes.length);
	while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(start, end).toString("utf8"), offset: base + end, truncated: offset < base };
}

/** Output readers have independent byte cursors; a GUI reader never consumes the agent's output. */
export function createBackgroundProcesses(changed: (ref: SessionRef) => void) {
	const records = new Map<string, ReturnType<typeof start>>();
	let stopping = false;
	function list(ref: SessionRef) {
		return [...records.values()]
			.filter((record) => sessionKey(record.value.ref) === sessionKey(ref))
			.map((record) => ({ ...record.value }));
	}
	function start(ref: SessionRef, command: string, timeoutMs: number) {
		const id = randomUUID();
		const windows = process.platform === "win32";
		// These are platform defaults when no login shell was supplied by the launching environment.
		const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
		const child = spawn(shell, windows ? ["/d", "/s", "/c", command] : ["-c", command], {
			cwd: ref.cwd,
			env: sanitizeChildProcessEnvironment(process.env),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: !windows,
		});
		const value: BackgroundProcess = {
			id,
			ref,
			command,
			status: "running",
			startedAt: Date.now(),
			finishedAt: null,
			exitCode: null,
			error: null,
		};
		const chunks: Buffer[] = [];
		let size = 0;
		let base = 0;
		let exited = false;
		let cleanup: Promise<void> | null = null;
		let stopPromise: Promise<BackgroundProcess> | null = null;
		let cancelled = false;
		const done = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		const publish = () => changed(ref);
		function cleanGroup() {
			return (cleanup ??= !windows && child.pid ? terminateProcessGroup(child.pid) : Promise.resolve());
		}
		const append = (text: string) => {
			if (!text) return;
			const bytes = Buffer.from(text);
			chunks.push(bytes);
			size += bytes.length;
			while ((size > RETAINED_BYTES && chunks.length > 1) || chunks.length > 1_024) {
				const first = chunks.shift()!;
				size -= first.length;
				base += first.length;
			}
			if (size > RETAINED_BYTES) {
				// Retained output always starts on a character boundary.
				let extra = size - RETAINED_BYTES;
				while (extra < chunks[0]!.length && (chunks[0]![extra]! & 0xc0) === 0x80) extra++;
				chunks[0] = chunks[0]!.subarray(extra);
				size -= extra;
				base += extra;
			}
		};
		for (const stream of [child.stdout, child.stderr]) {
			const decoder = new StringDecoder("utf8");
			stream.on("data", (data: Buffer) => append(decoder.write(data)));
			stream.on("end", () => append(decoder.end()));
		}
		child.once("spawn", () => ready.resolve());
		child.once("error", (error) => {
			value.error = error.message;
			ready.reject(error);
		});
		child.once("exit", () => {
			void cleanGroup().catch((error: unknown) => {
				value.error = toError(error).message;
				publish();
			});
		});
		child.once("close", (code) => {
			exited = true;
			clearTimeout(timer);
			value.finishedAt = Date.now();
			value.exitCode = code;
			value.status = cancelled ? "cancelled" : code === 0 && !value.error ? "completed" : "failed";
			void cleanGroup().then(
				() => {
					done.resolve();
					publish();
				},
				(error: unknown) => {
					value.error = toError(error).message;
					value.status = "failed";
					done.resolve();
					publish();
				},
			);
		});
		const timer = setTimeout(() => {
			value.error = "Background command exceeded its time limit";
			void stop().catch((error: unknown) => {
				value.error = toError(error).message;
				publish();
			});
		}, timeoutMs);
		function stop(): Promise<BackgroundProcess> {
			if (stopPromise) return stopPromise;
			if (exited) return done.promise.then(() => ({ ...value }));
			cancelled = true;
			value.status = "stopping";
			publish();
			stopPromise = (async () => {
				// A spawn failure owns no process, but its close event still settles the record.
				if (!child.pid) {
					await done.promise;
					return { ...value };
				}
				await ready.promise;
				if (!windows) await cleanGroup();
				else
					await terminateProcessTree({
						pid: child.pid,
						terminateRoot: () => {
							child.kill();
						},
						rootExited: () => exited,
					});
				await done.promise;
				return { ...value };
			})();
			return stopPromise;
		}
		return {
			value,
			ready: ready.promise,
			stop,
			async wait() {
				await done.promise;
				return { ...value };
			},
			read(offset: number) {
				return { process: { ...value }, ...readOutputWindow(Buffer.concat(chunks, size), base, offset) };
			},
			retained() {
				return { process: { ...value }, base, end: base + size, text: Buffer.concat(chunks, size).toString("utf8") };
			},
		};
	}
	function requireRecord(id: string) {
		const record = records.get(id);
		if (!record) throw new Error("Unknown background process");
		return record;
	}
	return {
		list,
		async start(ref: SessionRef, command: string, timeoutMs = 3_600_000) {
			if (stopping) throw new Error("Background processes are stopping");
			const running = [...records.values()].filter(
				(record) => record.value.status === "running" || record.value.status === "stopping",
			);
			if (
				running.length >= 16 ||
				running.filter((record) => sessionKey(record.value.ref) === sessionKey(ref)).length >= 4
			)
				throw new Error("Background task capacity reached; stop or wait for a task first");
			const record = start(ref, command, timeoutMs);
			records.set(record.value.id, record);
			try {
				await record.ready;
			} catch (error) {
				// A failed spawn still emits close; drain it before dropping its timer and output owner.
				await record.wait();
				records.delete(record.value.id);
				throw error;
			}
			changed(ref);
			return { ...record.value };
		},
		read: (id: string, offset: number) => requireRecord(id).read(offset),
		retained: (id: string) => requireRecord(id).retained(),
		stop: (id: string) => requireRecord(id).stop(),
		wait: (id: string) => requireRecord(id).wait(),
		/** Drops a settled process whose final state and output are persisted elsewhere. */
		forget(id: string) {
			if (records.get(id)?.value.finishedAt !== null) records.delete(id);
		},
		async release() {
			stopping = true;
			const targets = [...records.values()];
			const results = await Promise.allSettled(targets.map((record) => record.stop()));
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (failures.length) throw new AggregateError(failures, "Background processes could not be stopped");
			for (const record of targets) records.delete(record.value.id);
		},
	};
}
