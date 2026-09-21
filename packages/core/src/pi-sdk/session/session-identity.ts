import { errorMessage } from "@ling/contracts/ling-error";
import { createLingError, isLingError } from "@ling/core/ling-error";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { HEADER_PROBE_BYTES } from "./session-schema";

interface ProbedSessionIdentity {
	sessionId: string;
	/** Header cwd when present; callers may prefer an explicit override. */
	headerCwd: string | null;
}

function identityFromHeaderLine(line: string): ProbedSessionIdentity | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const header = parsed as { type?: unknown; id?: unknown; cwd?: unknown };
	if (header.type !== "session" || typeof header.id !== "string" || header.id.length === 0) return null;
	return {
		sessionId: header.id,
		headerCwd: typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : null,
	};
}

/**
 * Reads only the session header so callers can reserve a replacement target without
 * `SessionManager.open` (which would race a later open). Fail-fast: no filename fallback
 * and no soft-swallow of I/O errors — a bad/missing header is an explicit failure.
 */
export async function probeSessionIdentity(sessionFilePath: string): Promise<ProbedSessionIdentity> {
	let handle: FileHandle;
	try {
		handle = await open(sessionFilePath, "r");
	} catch (error) {
		throw createLingError({
			code: "INVALID_REQUEST",
			category: "lifecycle",
			message: `Unable to open session file for identity probe: ${basename(sessionFilePath)} (${errorMessage(error)})`,
			retryable: true,
			userAction: "retry",
			details: { sessionFilePath },
		});
	}
	try {
		const buffer = Buffer.allocUnsafe(HEADER_PROBE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead === 0) {
			throw createLingError({
				code: "INVALID_REQUEST",
				category: "lifecycle",
				message: `Session file is empty; cannot probe identity: ${basename(sessionFilePath)}`,
				retryable: false,
				details: { sessionFilePath },
			});
		}
		const chunk = buffer.subarray(0, bytesRead).toString("utf8");
		const newlineIndex = chunk.indexOf("\n");
		const line = newlineIndex < 0 ? chunk : chunk.slice(0, newlineIndex);
		const fromHeader = identityFromHeaderLine(line);
		if (!fromHeader) {
			throw createLingError({
				code: "INVALID_REQUEST",
				category: "lifecycle",
				message: `Session file has no valid session header: ${basename(sessionFilePath)}`,
				retryable: false,
				details: { sessionFilePath },
			});
		}
		return fromHeader;
	} catch (error) {
		if (isLingError(error)) throw error;
		throw createLingError(
			{
				code: "INVALID_REQUEST",
				category: "lifecycle",
				message: `Failed to read session header for identity probe: ${basename(sessionFilePath)} (${errorMessage(error)})`,
				retryable: true,
				userAction: "retry",
				details: { sessionFilePath },
			},
			error,
		);
	} finally {
		await handle.close();
	}
}
