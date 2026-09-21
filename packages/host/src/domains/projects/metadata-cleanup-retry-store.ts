import { SESSION_ID_MAX_CHARS } from "@ling/contracts/path-bounds";
import { pathStringSchema } from "@ling/contracts/path-validation";
import { sessionRefSchema as requestSessionRefSchema, type SessionRef } from "@ling/contracts/session-ref";
import type { ProjectRef } from "@ling/contracts/owner-ref";
import { readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import type { HostDatabase } from "../../storage/database";
import {
	DatasetReadError,
	datasetCorruption,
	inspectDatasetVersion,
	parseDatasetJson,
} from "@ling/host/storage/dataset-envelope";
import { join } from "node:path";
import { z } from "zod";

export type MetadataCleanupOwnerId = "sessionCatalog" | "changeReview";
export type MetadataCleanupFact =
	| { type: "sessionDeleted"; ref: SessionRef; occurredAt: number }
	| { type: "projectRemoved"; project: ProjectRef; sessionRefs: SessionRef[]; occurredAt: number };

export interface MetadataCleanupRetryRecord {
	id: string;
	fact: MetadataCleanupFact;
	pendingOwnerIds: MetadataCleanupOwnerId[];
	attempts: number;
	firstFailedAt: number;
	lastAttemptAt: number;
	errors: Partial<Record<MetadataCleanupOwnerId, string>>;
}

interface MetadataCleanupRetryDataset {
	schema: "ling/metadata-cleanup-retries";
	version: 2;
	writtenAt: number;
	records: MetadataCleanupRetryRecord[];
}

export interface MetadataCleanupRetryStore {
	list(): Promise<MetadataCleanupRetryRecord[]>;
	recordFailure(
		id: string,
		fact: MetadataCleanupFact,
		failures: Partial<Record<MetadataCleanupOwnerId, string>>,
		attemptedAt: number,
	): Promise<void>;
	remove(id: string): Promise<void>;
}

/** Dataset schema identifier; validated when reading from disk to prevent cross-reading other userData JSON. */
const DATASET_ID = "ling/metadata-cleanup-retries";
/** Current envelope version; a version bump needs a migration or the old retry queue must be rejected. */
const DATASET_VERSION = 2;
/** Retry queue file byte cap. 2MiB holds hundreds of failure records; beyond that it is treated as corruption/attack and refused. */
const MAX_DATASET_BYTES = 2 * 1024 * 1024;
/** Max retained retry records. 256 covers a brief failure storm; more just piles up stale facts and slows startup cleanup. */
const MAX_RETRY_RECORDS = 256;

const safeString = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.refine((value) => !value.includes("\0"));
// Version 2 stores retain their original acceptance rules; request validation is not a disk migration.
const storedProjectPathSchema = pathStringSchema("Stored project path");
const sessionRefSchema = requestSessionRefSchema.extend({
	cwd: storedProjectPathSchema,
	sessionId: safeString(SESSION_ID_MAX_CHARS),
});
const factSchema: z.ZodType<MetadataCleanupFact> = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("sessionDeleted"),
		ref: sessionRefSchema,
		occurredAt: z.number().int().nonnegative(),
	}),
	z.strictObject({
		type: z.literal("projectRemoved"),
		project: z.strictObject({ cwd: storedProjectPathSchema }),
		sessionRefs: z.array(sessionRefSchema).max(50_000),
		occurredAt: z.number().int().nonnegative(),
	}),
]);
const ownerIdSchema = z.enum(["sessionCatalog", "changeReview"]);
const retryRecordSchema: z.ZodType<MetadataCleanupRetryRecord> = z.strictObject({
	id: safeString(256),
	fact: factSchema,
	pendingOwnerIds: z.array(ownerIdSchema).min(1).max(3),
	attempts: z.number().int().positive(),
	firstFailedAt: z.number().int().nonnegative(),
	lastAttemptAt: z.number().int().nonnegative(),
	errors: z
		.strictObject({
			sessionCatalog: z.string().max(4_096).optional(),
			changeReview: z.string().max(4_096).optional(),
		})
		.transform(({ sessionCatalog, changeReview }): Partial<Record<MetadataCleanupOwnerId, string>> => ({
			...(sessionCatalog !== undefined ? { sessionCatalog } : {}),
			...(changeReview !== undefined ? { changeReview } : {}),
		})),
});
const retryDatasetSchema: z.ZodType<MetadataCleanupRetryDataset> = z.strictObject({
	schema: z.literal(DATASET_ID),
	version: z.literal(DATASET_VERSION),
	writtenAt: z.number().int().nonnegative(),
	records: z.array(retryRecordSchema).max(MAX_RETRY_RECORDS),
});
function cloneFact(fact: MetadataCleanupFact): MetadataCleanupFact {
	return fact.type === "sessionDeleted"
		? { ...fact, ref: { ...fact.ref } }
		: { ...fact, project: { ...fact.project }, sessionRefs: fact.sessionRefs.map((ref) => ({ ...ref })) };
}

function cloneRecord(record: MetadataCleanupRetryRecord): MetadataCleanupRetryRecord {
	return {
		...record,
		fact: cloneFact(record.fact),
		pendingOwnerIds: [...record.pendingOwnerIds],
		errors: { ...record.errors },
	};
}

function parseMetadataCleanupRetryDataset(source: string, filePath?: string): MetadataCleanupRetryDataset {
	const value = parseDatasetJson(source, DATASET_ID, filePath);
	try {
		inspectDatasetVersion(value, {
			datasetId: DATASET_ID,
			schema: DATASET_ID,
			currentVersion: DATASET_VERSION,
			...(filePath !== undefined ? { filePath } : {}),
		});
		return retryDatasetSchema.parse(value);
	} catch (error) {
		if (error instanceof DatasetReadError) throw error;
		throw datasetCorruption(DATASET_ID, "Metadata cleanup retry state failed schema validation.", {
			...(filePath !== undefined ? { filePath } : {}),
			cause: error,
		});
	}
}

function serializeMetadataCleanupRetryDataset(dataset: MetadataCleanupRetryDataset): string {
	const parsed = retryDatasetSchema.parse(dataset);
	const contents = `${JSON.stringify(parsed, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_DATASET_BYTES) {
		throw datasetCorruption(DATASET_ID, `Metadata cleanup retry state exceeds ${MAX_DATASET_BYTES} bytes.`);
	}
	return contents;
}

export function createMetadataCleanupRetryStore({
	userDataDir,
	database,
}: {
	userDataDir: string;
	database: HostDatabase;
}): MetadataCleanupRetryStore {
	const source = join(userDataDir, "metadata-cleanup-retries.json");
	function ensureImported() {
		database.importLegacy({
			key: DATASET_ID,
			source,
			read() {
				const contents = readUtf8FileSyncBounded(source, MAX_DATASET_BYTES);
				// No failed cleanup has been recorded on a fresh installation.
				return contents === undefined ? [] : parseMetadataCleanupRetryDataset(contents, source).records;
			},
			publish(records) {
				for (const record of records)
					database.run(
						"INSERT INTO cleanup_retries(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
						record.id,
						JSON.stringify(record),
					);
			},
		});
	}
	function readRecords() {
		ensureImported();
		const rows = database.all("SELECT payload FROM cleanup_retries ORDER BY rowid LIMIT ?", MAX_RETRY_RECORDS + 1);
		const records = rows.map((row) =>
			retryRecordSchema.parse(parseDatasetJson(z.object({ payload: z.string() }).parse(row).payload, DATASET_ID)),
		);
		serializeMetadataCleanupRetryDataset({
			schema: DATASET_ID,
			version: DATASET_VERSION,
			writtenAt: Date.now(),
			records,
		});
		return records;
	}
	return {
		async list() {
			return readRecords().map(cloneRecord);
		},
		async recordFailure(id, fact, failures, attemptedAt) {
			ensureImported();
			database.transaction(() => {
				const records = readRecords();
				const pendingOwnerIds = (Object.keys(failures) as MetadataCleanupOwnerId[]).filter(
					(ownerId) => failures[ownerId] !== undefined,
				);
				if (pendingOwnerIds.length === 0) throw new Error("A cleanup retry requires at least one failed owner");
				const existingIndex = records.findIndex((record) => record.id === id);
				const existing = records[existingIndex];
				const record: MetadataCleanupRetryRecord = {
					id,
					fact: cloneFact(fact),
					pendingOwnerIds,
					// Absence means this is the first failed attempt for this fact.
					attempts: (existing?.attempts ?? 0) + 1,
					firstFailedAt: existing?.firstFailedAt ?? attemptedAt,
					lastAttemptAt: attemptedAt,
					errors: { ...failures },
				};
				if (existingIndex === -1) records.push(record);
				else records[existingIndex] = record;
				serializeMetadataCleanupRetryDataset({
					schema: DATASET_ID,
					version: DATASET_VERSION,
					writtenAt: attemptedAt,
					records,
				});
				database.run(
					"INSERT INTO cleanup_retries(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
					id,
					JSON.stringify(record),
				);
			});
		},
		async remove(id) {
			ensureImported();
			database.run("DELETE FROM cleanup_retries WHERE id=?", id);
		},
	};
}
