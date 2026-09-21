import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

/**
 * Session-file schema skew detection.
 *
 * Pi session files carry a header version. The bundled SDK migrates older files up, but a
 * file written by a NEWER pi (a globally installed CLI ahead of the bundled SDK) is
 * consumed as-is: entry types the bundled SDK does not know are silently dropped during
 * projection, so transcript content disappears with no signal. We cannot render what the
 * bundled SDK cannot parse — instead the skew is detected up front and surfaced as a
 * session diagnostic so the user knows some content may not display.
 *
 * Detection is conservative: only a header version strictly greater than the bundled
 * SDK's flags. Missing, unreadable, or older versions never flag, so existing sessions
 * see zero behavior change.
 */

/** Session schema version the bundled SDK writes/understands; compared against the on-disk header version for skew. */
const RUNTIME_SESSION_SCHEMA_VERSION: number = CURRENT_SESSION_VERSION;

/** Read-only header probe size; the header is the first JSONL line, 16KiB is ample and keeps the probe O(1). */
export const HEADER_PROBE_BYTES = 16 * 1_024;

/** Extracts the schema version from a session file's first line. `undefined` when the
 * line is not a session header (unreadable, not JSON, wrong type). Pi treats a header
 * without a version field as v1. */
function schemaVersionFromHeaderLine(line: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const header = parsed as { type?: unknown; version?: unknown };
	if (header.type !== "session") return undefined;
	return typeof header.version === "number" ? header.version : 1;
}

/** Reads just the header line of a session JSONL and returns its schema version.
 * `undefined` when the file is missing, unreadable, or has no parseable header — skew
 * cannot be determined then and is treated as absent. */
export async function readSessionFileSchemaVersion(sessionFilePath: string): Promise<number | undefined> {
	let handle: FileHandle;
	try {
		handle = await open(sessionFilePath, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.allocUnsafe(HEADER_PROBE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead === 0) return undefined;
		const chunk = buffer.subarray(0, bytesRead).toString("utf8");
		const newlineIndex = chunk.indexOf("\n");
		// No newline within the probe: either a header far larger than pi ever writes, or a
		// truncated file — both are "cannot determine".
		if (newlineIndex < 0) return undefined;
		return schemaVersionFromHeaderLine(chunk.slice(0, newlineIndex));
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

/** Builds the warning diagnostic for a file written by a newer pi, or `null` when the
 * version is unknown, current, or older (no skew to report). */
export function sessionSchemaSkewDiagnostic(fileSchemaVersion: number | undefined): PiDiagnostic | null {
	if (fileSchemaVersion === undefined || fileSchemaVersion <= RUNTIME_SESSION_SCHEMA_VERSION) return null;
	return {
		protocolVersion: 1,
		code: "PI_SESSION_SCHEMA_NEWER",
		severity: "warning",
		source: "pi.session",
		message:
			`This session was written by a newer pi (schema v${fileSchemaVersion}; this build understands v${RUNTIME_SESSION_SCHEMA_VERSION}). ` +
			"Some content may not display. Update Ling, or continue the session in the newer pi CLI.",
		details: {
			fileSchemaVersion,
			runtimeSchemaVersion: RUNTIME_SESSION_SCHEMA_VERSION,
		},
	};
}
