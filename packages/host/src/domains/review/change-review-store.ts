import { ABSOLUTE_PATH_MAX_CHARS, SESSION_ID_MAX_CHARS } from "@ling/contracts/path-bounds";
import { isRecord as isDatasetRecord } from "@ling/contracts/records";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import type { ReviewSnapshotFile } from "@ling/core/change-review/change-review";
import { requestCancelled, toError } from "@ling/core/ling-error";
import { readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import type { GitReviewSnapshot } from "@ling/host/domains/git/git-service";
import {
	DatasetReadError,
	datasetCorruption,
	inspectDatasetVersion,
	parseDatasetJson,
} from "@ling/host/storage/dataset-envelope";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { HostDatabase } from "../../storage/database";
import type { ChangeReviewRuntimeState, StoredChangeState } from "./change-review-state";

const storedReviewFileSchema: z.ZodType<ReviewSnapshotFile> = z.strictObject({
	path: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS),
	from: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS).optional(),
	status: z.enum(["modified", "added", "deleted", "renamed", "copied", "untracked", "conflicted", "clean"]),
	additions: z.number().int().nonnegative().optional(),
	deletions: z.number().int().nonnegative().optional(),
	diff: z
		.string()
		.max(64 * 1024 * 1024)
		.optional(),
	identity: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});

const nullableStoredString = z.string().max(ABSOLUTE_PATH_MAX_CHARS).nullable();
const storedGitSnapshotSchema: z.ZodType<GitReviewSnapshot> = z.strictObject({
	isRepository: z.boolean(),
	gitRoot: nullableStoredString,
	headSha: z.string().max(128).nullable(),
	branch: z.string().max(SESSION_ID_MAX_CHARS).nullable(),
	files: z.array(storedReviewFileSchema).max(100_000),
});

const storedTurnBaseSchema = z.strictObject({
	id: z.string().min(1).max(SESSION_ID_MAX_CHARS),
	startedAt: z.number().int().nonnegative(),
	endedAt: z.number().int().nonnegative(),
	beforeHeadSha: z.string().max(128).nullable(),
	afterHeadSha: z.string().max(128).nullable(),
	// Boundary default: turns persisted before the transcript link existed carry no
	// initiating-message identity and stay unlinked.
	userMessageEntryId: z.string().min(1).max(SESSION_ID_MAX_CHARS).nullable().default(null),
	files: z.array(storedReviewFileSchema).max(100_000),
});
const storedTurnTrackingSchema = z.union([
	z.strictObject({ status: z.literal("complete") }),
	z.strictObject({
		status: z.literal("partial"),
		reason: z.enum(["shadowCaptureFailed", "captureLimitExceeded", "toolFallbackFailed", "legacyTracking"]),
	}),
]);
const legacyStoredTurnsSchema = z.array(storedTurnBaseSchema).max(10_000);
const storedTurnsSchema = z
	.array(
		storedTurnBaseSchema.extend({
			tracking: storedTurnTrackingSchema,
		}),
	)
	.max(10_000);
const storedChangeStateSchema: z.ZodType<StoredChangeState> = z.strictObject({
	ref: z.strictObject({
		cwd: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS),
		sessionId: z.string().min(1).max(SESSION_ID_MAX_CHARS),
	}),
	cwd: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS),
	baseline: storedGitSnapshotSchema,
	turns: storedTurnsSchema,
});
/** Dataset schema identifier; validated when reading from disk to prevent cross-reading other userData JSON. */
const CHANGE_REVIEW_DATASET_ID = "ling/change-review-state";
/** Current envelope version; v2→v3 carried the tracking-field migration, so a version bump needs a migration or old files must be rejected. */
const CHANGE_REVIEW_DATASET_VERSION = 3;
const storedChangeStateEnvelopeSchema = z.strictObject({
	schema: z.literal(CHANGE_REVIEW_DATASET_ID),
	version: z.literal(CHANGE_REVIEW_DATASET_VERSION),
	writtenAt: z.number().int().nonnegative(),
	data: storedChangeStateSchema,
});
type LegacyStoredChangeState = Omit<StoredChangeState, "turns"> & {
	turns: Array<Omit<StoredChangeState["turns"][number], "tracking">>;
};
const legacyStoredChangeStateSchema: z.ZodType<LegacyStoredChangeState> = z.strictObject({
	ref: z.strictObject({
		cwd: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS),
		sessionId: z.string().min(1).max(SESSION_ID_MAX_CHARS),
	}),
	cwd: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS),
	baseline: storedGitSnapshotSchema,
	turns: legacyStoredTurnsSchema,
});
const legacyStoredChangeStateEnvelopeSchema = z.strictObject({
	schema: z.literal(CHANGE_REVIEW_DATASET_ID),
	version: z.literal(2),
	writtenAt: z.number().int().nonnegative(),
	data: legacyStoredChangeStateSchema,
});

/**
 * Byte cap for a single session's review state file. 64MiB holds multi-turn patch text;
 * anything larger is treated as corruption/attack and refused, avoiding reading a huge
 * state blob wholesale into main-process memory.
 */
const MAX_STORED_CHANGE_STATE_BYTES = 64 * 1024 * 1024;

class ForeignChangeReviewStateError extends Error {}

function parseStoredState(text: string, ref: SessionRef): StoredChangeState {
	const raw = parseDatasetJson(text, CHANGE_REVIEW_DATASET_ID);
	let parsed: StoredChangeState;
	try {
		inspectDatasetVersion(raw, {
			datasetId: CHANGE_REVIEW_DATASET_ID,
			schema: CHANGE_REVIEW_DATASET_ID,
			currentVersion: CHANGE_REVIEW_DATASET_VERSION,
			minSupportedVersion: 2,
		});
		if (!isDatasetRecord(raw)) throw new Error("Change review state envelope is invalid");
		if (raw.version === 2) {
			const legacy = legacyStoredChangeStateEnvelopeSchema.parse(raw).data;
			parsed = {
				...legacy,
				turns: legacy.turns.map((turn) => ({
					...turn,
					tracking: { status: "partial", reason: "legacyTracking" },
				})),
			};
		} else {
			parsed = storedChangeStateEnvelopeSchema.parse(raw).data;
		}
	} catch (error) {
		if (error instanceof DatasetReadError) throw error;
		throw datasetCorruption(CHANGE_REVIEW_DATASET_ID, "Change review state failed schema validation.", {
			cause: error,
		});
	}
	if (sessionKey(parsed.ref) !== sessionKey(ref) || parsed.cwd !== ref.cwd) {
		throw new ForeignChangeReviewStateError("Change review state belongs to a different session");
	}
	return parsed;
}

export function withoutPatches(snapshot: GitReviewSnapshot): GitReviewSnapshot {
	return {
		...snapshot,
		files: snapshot.files.map((file) => {
			const clean: ReviewSnapshotFile = { path: file.path, status: file.status };
			if (file.from !== undefined) clean.from = file.from;
			if (file.additions !== undefined) clean.additions = file.additions;
			if (file.deletions !== undefined) clean.deletions = file.deletions;
			if (file.identity !== undefined) clean.identity = file.identity;
			return clean;
		}),
	};
}

/** Historical review envelopes retain their versioned payload; SQLite owns publication and session association. */
export function createChangeReviewStore({ userDataDir, database }: { userDataDir: string; database: HostDatabase }) {
	function legacy(ref: SessionRef) {
		const digest = createHash("sha256").update(sessionKey(ref)).digest("hex");
		return {
			key: `${CHANGE_REVIEW_DATASET_ID}:${digest}`,
			source: join(userDataDir, "session-changes", `${digest}.json`),
		};
	}
	function writeState(state: StoredChangeState) {
		const stored: StoredChangeState = {
			ref: state.ref,
			cwd: state.cwd,
			baseline: withoutPatches(state.baseline),
			turns: state.turns,
		};
		const contents = JSON.stringify({
			schema: CHANGE_REVIEW_DATASET_ID,
			version: CHANGE_REVIEW_DATASET_VERSION,
			writtenAt: Date.now(),
			data: stored,
		});
		if (Buffer.byteLength(contents, "utf8") > MAX_STORED_CHANGE_STATE_BYTES)
			throw new Error(`Serialized change review state exceeds ${MAX_STORED_CHANGE_STATE_BYTES} bytes`);
		database.run(
			"INSERT INTO review_state(cwd,session_id,payload) VALUES(?,?,?) ON CONFLICT(cwd,session_id) DO UPDATE SET payload=excluded.payload",
			state.ref.cwd,
			state.ref.sessionId,
			contents,
		);
	}
	function ensureImported(ref: SessionRef) {
		const location = legacy(ref);
		database.importLegacy({
			...location,
			read() {
				const text = readUtf8FileSyncBounded(location.source, MAX_STORED_CHANGE_STATE_BYTES);
				return text === undefined ? null : parseStoredState(text, ref);
			},
			publish(state) {
				if (state !== null) writeState(state);
			},
		});
	}
	async function loadState(ref: SessionRef): Promise<ChangeReviewRuntimeState | null> {
		if (database.isSessionDeleted(sessionKey(ref))) return null;
		ensureImported(ref);
		const row = database.get("SELECT payload FROM review_state WHERE cwd=? AND session_id=?", ref.cwd, ref.sessionId);
		if (row === undefined) return null;
		const { text } = z
			.object({ payload: z.string() })
			.transform((row) => ({ text: row.payload }))
			.parse(row);
		// Reviewed progress can exist before the first runtime baseline is captured.
		if (text === "null") return null;
		if (Buffer.byteLength(text, "utf8") > MAX_STORED_CHANGE_STATE_BYTES)
			throw datasetCorruption(CHANGE_REVIEW_DATASET_ID, "Stored review state exceeds its byte budget");
		const state = parseStoredState(text, ref);
		state.baseline = withoutPatches(state.baseline);
		return state;
	}
	async function persist(state: ChangeReviewRuntimeState) {
		if (database.isSessionDeleted(sessionKey(state.ref))) throw requestCancelled("The reviewed session was deleted.");
		ensureImported(state.ref);
		writeState(state);
	}
	async function recoverState(state: ChangeReviewRuntimeState) {
		if (database.isSessionDeleted(sessionKey(state.ref))) throw requestCancelled("The reviewed session was deleted.");
		const location = legacy(state.ref);
		database.transaction(() => {
			writeState(state);
			database.markImported(location.key, location.source);
		});
	}
	async function inspectStoredStateFailure(ref: SessionRef): Promise<Error | null> {
		try {
			await loadState(ref);
			return null;
		} catch (error) {
			if (error instanceof ForeignChangeReviewStateError)
				return datasetCorruption(CHANGE_REVIEW_DATASET_ID, "Change review state ownership is invalid.");
			return toError(error);
		}
	}
	return {
		loadState,
		persist,
		recoverState,
		inspectStoredStateFailure,
	};
}
export type ChangeReviewStore = ReturnType<typeof createChangeReviewStore>;
