import { createLaunchLog } from "@ling/node-runtime/launch-log";
import { formatWithOptions } from "node:util";

export interface DesktopLog {
	/** Mirrors every later console line to the Host diagnostics store while a Host is attached. */
	attachForwarder(write: (line: string) => void): () => void;
}

/** Native startup, updater and fatal-exit errors must remain readable without a terminal or a Host. */
export function installDesktopLog(directory: string): DesktopLog {
	let forwarder: ((line: string) => void) | null = null;
	let file: ReturnType<typeof createLaunchLog> | null = null;
	try {
		file = createLaunchLog(directory);
	} catch (error) {
		console.error("Desktop file logging is unavailable; using the console", error);
	}
	const levels = ["log", "info", "warn", "error", "debug"] as const;
	const originals = new Map(levels.map((level) => [level, console[level]]));
	const dispose = (): void => {
		for (const [level, original] of originals) console[level] = original;
		process.off("exit", dispose);
		try {
			file?.dispose();
		} catch (error) {
			console.error("Failed to close Desktop log file", error);
		}
	};
	for (const [level, original] of originals) {
		console[level] = (...args: unknown[]) => {
			original.apply(console, args);
			// Bound inspected objects; 16 KiB keeps a native stack and causes without dumping payloads.
			const line = formatWithOptions(
				{ colors: false, depth: 4, maxArrayLength: 20, maxStringLength: 4_096 },
				...args,
			).slice(0, 16_384);
			try {
				file?.write(level, line);
			} catch (error) {
				dispose();
				console.error("Desktop file logging failed; using the console", error);
			}
			forwarder?.(
				JSON.stringify({
					"@ling": 1,
					at: Date.now(),
					level: level === "error" ? "error" : level === "warn" ? "warn" : "info",
					process: "desktop",
					component: "shell",
					message: line.replace(/\s+/g, " ").trim(),
				}),
			);
		};
	}
	process.once("exit", dispose);
	console.info("Ling Desktop started", { pid: process.pid });
	return {
		attachForwarder(write) {
			forwarder = write;
			return () => {
				if (forwarder === write) forwarder = null;
			};
		},
	};
}
