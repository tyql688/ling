import { errorMessage } from "@ling/contracts/ling-error";
import { ABSOLUTE_PATH_MAX_CHARS, SESSION_ID_MAX_CHARS } from "@ling/contracts/path-bounds";
import { isRecord as isDatasetRecord } from "@ling/contracts/records";
import { nonEmptyBoundedString, safeIdSchema, strictObject } from "@ling/contracts/schema-primitives";
import { SESSION_SUMMARY_PREVIEW_MAX_CHARS, SESSION_TITLE_MAX_CHARS } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import type { ListedSessionSummary } from "@ling/host/domains/sessions/manager/session-summary";
import {
	DatasetReadError,
	datasetCorruption,
	inspectDatasetVersion,
	parseDatasetJson,
} from "@ling/host/storage/dataset-envelope";
import { z } from "zod";

/** Version 5 adds derived fork provenance; older summaries must be rescanned before cache reuse. */
const SESSION_CATALOG_VERSION = 5;
/** Version 3 retains the same authoritative pin/archive metadata but has no derived summaries. */
const MIN_SUPPORTED_SESSION_CATALOG_VERSION = 3;
/** Version 4 cached summaries omit fork provenance. */
const LEGACY_SUMMARY_CATALOG_VERSION = 4;
export const SESSION_CATALOG_DATASET_ID = "ling/session-catalog";
/** 16 MiB bounds both metadata and the derived sidebar summaries. */
export const MAX_SESSION_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_CATALOG_ENTRIES = 50_000;

export interface SessionCatalogEntry {
	ref: SessionRef;
	sessionFilePath: string;
	archivedAt?: number;
	pinnedAt?: number;
	cachedSummary?: {
		title: string;
		createdAt: number;
		updatedAt: number;
		messageCount: number;
		preview: string;
		parentSessionFilePath?: string;
		manualFork?: boolean;
		fingerprint: { size: number; modifiedAtMs: number };
	};
}

export type SessionCatalogSource = ListedSessionSummary;

interface SessionCatalogShape {
	schema: typeof SESSION_CATALOG_DATASET_ID;
	version: typeof SESSION_CATALOG_VERSION;
	writtenAt: number;
	sessions: SessionCatalogEntry[];
}

const catalogPathStringSchema = nonEmptyBoundedString(ABSOLUTE_PATH_MAX_CHARS, "Catalog path").refine(
	(value) => !value.includes("\0"),
	"Catalog path must not contain NUL",
);
const catalogTimestampSchema = z.number().nonnegative();
const legacyCatalogEntryShape = {
	ref: strictObject({
		cwd: catalogPathStringSchema,
		sessionId: safeIdSchema(SESSION_ID_MAX_CHARS, "Session id"),
	}),
	sessionFilePath: catalogPathStringSchema,
	archivedAt: catalogTimestampSchema.optional(),
	pinnedAt: catalogTimestampSchema.optional(),
};
const legacyCachedSummaryShape = {
	title: z.string().max(SESSION_TITLE_MAX_CHARS),
	createdAt: catalogTimestampSchema,
	updatedAt: catalogTimestampSchema,
	messageCount: z.number().int().nonnegative(),
	preview: z.string().max(SESSION_SUMMARY_PREVIEW_MAX_CHARS),
	parentSessionFilePath: catalogPathStringSchema.optional(),
	// Legacy flag from the removed delegate-worker feature; tolerated so existing catalogs still parse, never written.
	isDelegateWorker: z.boolean().optional(),
	fingerprint: strictObject({
		size: z.number().int().nonnegative(),
		modifiedAtMs: catalogTimestampSchema,
	}),
};
const cachedSummarySchema = strictObject({ ...legacyCachedSummaryShape, manualFork: z.boolean().optional() });
const legacyCatalogEntrySchema = strictObject(legacyCatalogEntryShape);
const catalogEntrySchema = strictObject({
	...legacyCatalogEntryShape,
	cachedSummary: cachedSummarySchema.optional(),
});
const legacySessionCatalogSchema = strictObject({
	schema: z.literal(SESSION_CATALOG_DATASET_ID),
	version: z.literal(MIN_SUPPORTED_SESSION_CATALOG_VERSION),
	writtenAt: z.number().int().nonnegative(),
	sessions: z.array(legacyCatalogEntrySchema).max(MAX_SESSION_CATALOG_ENTRIES),
});
const sessionCatalogSchema = strictObject({
	schema: z.literal(SESSION_CATALOG_DATASET_ID),
	version: z.literal(SESSION_CATALOG_VERSION),
	writtenAt: z.number().int().nonnegative(),
	sessions: z.array(catalogEntrySchema).max(MAX_SESSION_CATALOG_ENTRIES),
});
const legacySummaryCatalogSchema = strictObject({
	schema: z.literal(SESSION_CATALOG_DATASET_ID),
	version: z.literal(LEGACY_SUMMARY_CATALOG_VERSION),
	writtenAt: z.number().int().nonnegative(),
	sessions: z
		.array(
			strictObject({
				...legacyCatalogEntryShape,
				cachedSummary: strictObject(legacyCachedSummaryShape).optional(),
			}),
		)
		.max(MAX_SESSION_CATALOG_ENTRIES),
});

function toCatalogEntry(
	entry: z.infer<typeof catalogEntrySchema> | z.infer<typeof legacyCatalogEntrySchema>,
): SessionCatalogEntry {
	return {
		ref: { ...entry.ref },
		sessionFilePath: entry.sessionFilePath,
		...(entry.archivedAt !== undefined ? { archivedAt: entry.archivedAt } : {}),
		...(entry.pinnedAt !== undefined ? { pinnedAt: entry.pinnedAt } : {}),
		...("cachedSummary" in entry && entry.cachedSummary !== undefined
			? {
					cachedSummary: {
						title: entry.cachedSummary.title,
						createdAt: entry.cachedSummary.createdAt,
						updatedAt: entry.cachedSummary.updatedAt,
						messageCount: entry.cachedSummary.messageCount,
						preview: entry.cachedSummary.preview,
						...(entry.cachedSummary.parentSessionFilePath !== undefined
							? { parentSessionFilePath: entry.cachedSummary.parentSessionFilePath }
							: {}),
						...(entry.cachedSummary.manualFork === undefined ? {} : { manualFork: entry.cachedSummary.manualFork }),
						fingerprint: { ...entry.cachedSummary.fingerprint },
					},
				}
			: {}),
	};
}

/** SQLite rows use the same authoritative metadata and bounded summary contract as migrated catalogs. */
export function parseSessionCatalogEntries(value: unknown): SessionCatalogEntry[] {
	try {
		return z.array(catalogEntrySchema).max(MAX_SESSION_CATALOG_ENTRIES).parse(value).map(toCatalogEntry);
	} catch (error) {
		throw datasetCorruption(SESSION_CATALOG_DATASET_ID, "Stored catalog rows failed schema validation.", {
			cause: error,
		});
	}
}
export function parseSessionCatalogDocument(contents: string): {
	entries: SessionCatalogEntry[];
	migrated: boolean;
} {
	const value = parseDatasetJson(contents, SESSION_CATALOG_DATASET_ID);
	try {
		inspectDatasetVersion(value, {
			datasetId: SESSION_CATALOG_DATASET_ID,
			schema: SESSION_CATALOG_DATASET_ID,
			currentVersion: SESSION_CATALOG_VERSION,
			minSupportedVersion: MIN_SUPPORTED_SESSION_CATALOG_VERSION,
		});
		if (!isDatasetRecord(value)) throw datasetCorruption(SESSION_CATALOG_DATASET_ID, "Invalid session catalog");
		if (value.version === MIN_SUPPORTED_SESSION_CATALOG_VERSION) {
			return { entries: legacySessionCatalogSchema.parse(value).sessions.map(toCatalogEntry), migrated: true };
		}
		if (value.version === LEGACY_SUMMARY_CATALOG_VERSION) {
			return { entries: legacySummaryCatalogSchema.parse(value).sessions.map(toCatalogEntry), migrated: true };
		}
		return { entries: sessionCatalogSchema.parse(value).sessions.map(toCatalogEntry), migrated: false };
	} catch (error) {
		if (error instanceof DatasetReadError) throw error;
		throw datasetCorruption(
			SESSION_CATALOG_DATASET_ID,
			`Session catalog failed schema validation: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}

export function serializeSessionCatalog(entries: readonly SessionCatalogEntry[], writtenAt = Date.now()): string {
	const catalog = sessionCatalogSchema.parse({
		schema: SESSION_CATALOG_DATASET_ID,
		version: SESSION_CATALOG_VERSION,
		writtenAt,
		sessions: [...entries],
	} satisfies SessionCatalogShape);
	const contents = `${JSON.stringify(catalog, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_SESSION_CATALOG_BYTES) {
		throw new Error(`Session catalog would exceed ${MAX_SESSION_CATALOG_BYTES} bytes`);
	}
	return contents;
}

export function cloneCatalogEntries(entries: readonly SessionCatalogEntry[]): SessionCatalogEntry[] {
	return entries.map((entry) => ({
		...entry,
		ref: { ...entry.ref },
		...(entry.cachedSummary
			? {
					cachedSummary: {
						...entry.cachedSummary,
						fingerprint: { ...entry.cachedSummary.fingerprint },
					},
				}
			: {}),
	}));
}

export function catalogFingerprint(entries: readonly SessionCatalogEntry[]): string {
	return JSON.stringify(entries);
}

export function cachedSummaryFromSource(
	summary: SessionCatalogSource,
): NonNullable<SessionCatalogEntry["cachedSummary"]> | null {
	if (!summary.sourceFingerprint) return null;
	return {
		title: summary.title,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
		messageCount: summary.messageCount,
		preview: summary.preview,
		...(summary.parentSessionFilePath ? { parentSessionFilePath: summary.parentSessionFilePath } : {}),
		...(summary.manualFork === undefined ? {} : { manualFork: summary.manualFork }),
		fingerprint: { ...summary.sourceFingerprint },
	};
}

export function cachedSessionSummariesFromCatalog(catalog: readonly SessionCatalogEntry[]): ListedSessionSummary[] {
	return catalog.flatMap((entry) => {
		const cached = entry.cachedSummary;
		if (!cached) return [];
		return [
			{
				id: entry.ref.sessionId,
				cwd: entry.ref.cwd,
				title: cached.title,
				createdAt: cached.createdAt,
				updatedAt: cached.updatedAt,
				messageCount: cached.messageCount,
				preview: cached.preview,
				sessionFilePath: entry.sessionFilePath,
				...(cached.parentSessionFilePath ? { parentSessionFilePath: cached.parentSessionFilePath } : {}),
				// Old catalogs have no origin projection. Keep their display/metadata, but rescan the Pi file.
				...(cached.manualFork === undefined
					? {}
					: { manualFork: cached.manualFork, sourceFingerprint: { ...cached.fingerprint } }),
			},
		];
	});
}
