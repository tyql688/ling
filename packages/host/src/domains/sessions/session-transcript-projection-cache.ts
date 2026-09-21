import { appVersionSchema } from "@ling/contracts/application";
import type { SessionMessage, SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import { toError } from "@ling/core/ling-error";
import { sessionMessagesSchema } from "@ling/core/pi-protocol/runtime-payload-schemas";
import type { SessionTranscriptProjectionCache } from "@ling/host/domains/sessions/transcript-projection-cache-port";
import { FileSizeLimitError, readUtf8FileBounded, writeTextFileAtomic } from "@ling/core/store/atomic-file-store";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";

/** Format revision for persisted transcript projections; changing the projected shape invalidates older files. */
const CACHE_FORMAT_VERSION = 2 as const;
/** Keep synchronous parsing bounded: a real 108 MiB projection stalled Host for 174–236 ms.
 * Larger projections use the authoritative Pi reader instead of this optional cache. */
const CACHE_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** Yield during serialization so a long sequence of small messages cannot monopolize Host. */
const SERIALIZE_BATCH_ITEMS = 128;
/** Projection keys are hashes plus a small resource revision prefix; 4KiB rejects corrupt headers generously. */
const CACHE_KEY_MAX_CHARS = 4_096;
const CACHE_DATASET = "ling.session-transcript-projection" as const;

interface ProjectionCacheDataset {
	dataset: typeof CACHE_DATASET;
	version: typeof CACHE_FORMAT_VERSION;
	appVersion: string;
	cacheKey: string;
	messages: readonly SessionMessage[];
}

function cacheFilePath(directory: string, ref: SessionRef): string {
	const identity = createHash("sha256").update(sessionKey(ref)).digest("base64url");
	return join(directory, `${identity}.json`);
}

function cacheRecord(value: unknown, filePath: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Transcript projection cache is not an object: ${filePath}`);
	}
	return value as Record<string, unknown>;
}

function parseJson(contents: string, filePath: string): unknown {
	try {
		return JSON.parse(contents) as unknown;
	} catch (error) {
		throw new Error(`Transcript projection cache is not valid JSON: ${filePath}`, { cause: toError(error) });
	}
}

function isMissingFile(error: unknown): boolean {
	return (toError(error) as NodeJS.ErrnoException).code === "ENOENT";
}

export function createSessionTranscriptProjectionCache(options: {
	userDataDir: string;
	appVersion: string;
}): SessionTranscriptProjectionCache {
	const directory = join(options.userDataDir, "session-transcript-projections");
	const appVersion = appVersionSchema.parse(options.appVersion);
	const datasetSchema = z.strictObject({
		dataset: z.literal(CACHE_DATASET),
		version: z.literal(CACHE_FORMAT_VERSION),
		appVersion: z.literal(appVersion),
		cacheKey: z.string().min(1).max(CACHE_KEY_MAX_CHARS),
		messages: sessionMessagesSchema,
	});

	return {
		async read(ref, expectedCacheKey) {
			const filePath = cacheFilePath(directory, ref);
			let contents: string | undefined;
			try {
				contents = await readUtf8FileBounded(filePath, CACHE_FILE_MAX_BYTES);
			} catch (error) {
				// Older builds admitted 256 MiB files. Size alone makes that derived hint
				// ineligible; corruption and I/O failures still propagate to the caller.
				if (error instanceof FileSizeLimitError) return null;
				throw error;
			}
			if (contents === undefined) return null;
			const candidate = cacheRecord(parseJson(contents, filePath), filePath);
			if (candidate.dataset !== CACHE_DATASET) {
				throw new Error(`Transcript projection cache has an unknown dataset: ${filePath}`);
			}
			if (!z.number().int().nonnegative().safeParse(candidate.version).success) {
				throw new Error(`Transcript projection cache has an invalid version: ${filePath}`);
			}
			if (candidate.version !== CACHE_FORMAT_VERSION) return null;
			if (typeof candidate.appVersion !== "string") {
				throw new Error(`Transcript projection cache has an invalid app version: ${filePath}`);
			}
			if (candidate.appVersion !== appVersion) return null;
			if (typeof candidate.cacheKey !== "string") {
				throw new Error(`Transcript projection cache has an invalid source key: ${filePath}`);
			}
			if (candidate.cacheKey !== expectedCacheKey) return null;
			// Zod models an optional object key as `T | undefined`; the shared contract uses
			// exact optional keys. Runtime validation is equivalent, but TypeScript cannot express it.
			return datasetSchema.parse(candidate).messages as SessionMessage[];
		},
		async write(ref, cacheKey, messages) {
			if (messages.some((message) => message.entryId === null)) {
				throw new Error("A transcript projection cache may contain only persisted session entries");
			}
			const header: Omit<ProjectionCacheDataset, "messages"> = {
				dataset: CACHE_DATASET,
				version: CACHE_FORMAT_VERSION,
				appVersion,
				cacheKey,
			};
			const prefix = `${JSON.stringify(header).slice(0, -1)},"messages":[`;
			const parts = [prefix];
			let bytes = Buffer.byteLength(prefix) + 2;
			for (let index = 0; index < messages.length; index += 1) {
				const encoded = `${index === 0 ? "" : ","}${JSON.stringify(messages[index])}`;
				bytes += Buffer.byteLength(encoded);
				if (bytes > CACHE_FILE_MAX_BYTES) return "projectionTooLarge";
				parts.push(encoded);
				if ((index + 1) % SERIALIZE_BATCH_ITEMS === 0) await setImmediate();
			}
			parts.push("]}");
			await writeTextFileAtomic(cacheFilePath(directory, ref), parts.join(""));
			return "written";
		},
		async delete(ref) {
			try {
				await unlink(cacheFilePath(directory, ref));
			} catch (error) {
				if (!isMissingFile(error)) throw error;
			}
		},
	};
}
