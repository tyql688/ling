import { readUtf8FileBounded, writeTextFileAtomic } from "@ling/core/store/atomic-file-store";
import { join } from "node:path";
import { z } from "zod";

/** Ports below 1024 are privileged on Unix and are never valid for Ling's loopback Host. */
const HOST_PORT_MIN = 1_024;
/** TCP ports are unsigned 16-bit values. */
const HOST_PORT_MAX = 65_535;
/** The state contains one integer; 1 KiB rejects corrupt input without constraining valid data. */
const HOST_PORT_STATE_MAX_BYTES = 1_024;
const HOST_PORT_STATE_FILE = "host-port.json";

const stateSchema = z.strictObject({
	port: z.number().int().min(HOST_PORT_MIN).max(HOST_PORT_MAX),
});

export async function loadPreferredHostPort(userDataDirectory: string): Promise<number | null> {
	const path = join(userDataDirectory, HOST_PORT_STATE_FILE);
	const source = await readUtf8FileBounded(path, HOST_PORT_STATE_MAX_BYTES);
	return source === undefined ? null : stateSchema.parse(JSON.parse(source) as unknown).port;
}

export async function savePreferredHostPort(userDataDirectory: string, port: number): Promise<void> {
	const validated = stateSchema.parse({ port });
	const destination = join(userDataDirectory, HOST_PORT_STATE_FILE);
	await writeTextFileAtomic(destination, `${JSON.stringify(validated)}\n`);
}
