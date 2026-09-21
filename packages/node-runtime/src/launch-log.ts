import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Ten launches cover recent failures without retaining an unbounded log history. */
const RETAINED_LAUNCHES = 10;
/** A runaway process may write at most 32 MiB in one launch. */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const LOG_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+-[a-f0-9-]+\.log$/;

/** Each process owner supplies its own directory and keeps its console fallback.
 * Writes are synchronous so fatal exit cannot discard a buffered diagnostic. */
export function createLaunchLog(directory: string) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID()}.log`;
	const path = join(directory, name);
	let fd: number | null = openSync(path, "wx", 0o600);
	let written = 0;
	const dispose = (): void => {
		if (fd === null) return;
		const owned = fd;
		fd = null;
		closeSync(owned);
	};
	try {
		const previous = readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name !== name && LOG_NAME.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		for (const stale of previous.slice(0, Math.max(0, previous.length - RETAINED_LAUNCHES + 1))) {
			unlinkSync(join(directory, stale));
		}
	} catch (error) {
		dispose();
		throw error;
	}
	return {
		path,
		dispose,
		write(level: string, line: string): void {
			if (fd === null) return;
			const entry = `${new Date().toISOString()} ${level.padEnd(5)} ${line}\n`;
			const bytes = Buffer.byteLength(entry);
			if (written + bytes > MAX_LOG_BYTES) {
				const notice = `${new Date().toISOString()} warn  Log cap reached; further lines use the console only.\n`;
				try {
					if (written + Buffer.byteLength(notice) <= MAX_LOG_BYTES) writeSync(fd, notice);
				} finally {
					dispose();
				}
				return;
			}
			writeSync(fd, entry);
			written += bytes;
		},
	};
}
