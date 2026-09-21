import { Buffer } from "node:buffer";

/** Every host transport frames JSON over a pipe, so an unserializable or oversized
 * payload must be rejected before it reaches the wire. */
export function assertJsonFrameSize(value: unknown, maxBytes: number, label: string): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new Error(`${label} must be JSON-safe.`, { cause: error });
	}
	if (serialized === undefined) throw new Error(`${label} must be JSON-safe.`);
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
		throw new Error(`${label} exceeds the ${maxBytes}-byte transport limit.`);
	}
}
