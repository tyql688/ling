import type { ChangeReviewTrackingState } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session";
import type { ReviewSnapshotFile } from "@ling/core/change-review/change-review";
import type { PiTurnContext, PiTurnFallbackCapture, PiTurnLifecycleHost } from "@ling/core/pi-protocol/turn-review";
import type { SessionRuntimeChangeReviewEvent } from "@ling/core/pi-protocol/runtime-types";
import { randomUUID } from "node:crypto";
import { createLogger } from "@ling/core/logger";
import type { ChangeReviewRuntimeOwner } from "./change-review-runtime";
import { partialReasonForShadowFailure } from "./change-review-shadow";
import type { ChangeReviewRuntimeState, StoredTurnTrackingState } from "./change-review-state";
import { withoutPatches, type ChangeReviewStore } from "./change-review-store";

const log = createLogger("change-review-capture");

interface ChangeReviewCaptureOwner {
	turnLifecycleHost: PiTurnLifecycleHost;
	recordFileUpdate(
		ref: SessionRef,
		event: Extract<SessionRuntimeChangeReviewEvent, { type: "changeReviewFileUpdated" }>,
	): Promise<boolean>;
	recordTrackingFailure(ref: SessionRef): Promise<boolean>;
}

function turnId(timestamp: number): string {
	return `turn-${timestamp}-${randomUUID()}`;
}

function fallbackFiles(
	active: NonNullable<ChangeReviewRuntimeState["activeTurn"]>,
	fallback: PiTurnFallbackCapture,
): ReviewSnapshotFile[] {
	const files = new Map(active.trackedFiles);
	for (const file of fallback.files) files.set(file.path, file);
	return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function createChangeReviewCaptureOwner(
	runtime: ChangeReviewRuntimeOwner,
	persist: ChangeReviewStore["persist"],
): ChangeReviewCaptureOwner {
	const finalizeActiveTurn = async (
		state: ChangeReviewRuntimeState,
		ref: SessionRef,
		timestamp: number,
		fallback: PiTurnFallbackCapture,
		context?: PiTurnContext,
	): Promise<void> => {
		const active = state.activeTurn;
		if (!active) return;
		let files: ReviewSnapshotFile[];
		let tracking: StoredTurnTrackingState;
		if (active.shadowCheckpoint !== null) {
			try {
				files = (await runtime.ensureShadowSession(state).finish(active.shadowCheckpoint)).files;
				tracking = { status: "complete" };
			} catch (error) {
				log.warn(`Final change capture failed for ${ref.sessionId}; retaining file-tool changes:`, error);
				files = fallbackFiles(active, fallback);
				tracking = {
					status: "partial",
					reason:
						fallback.failureCode !== null || active.toolTrackingFailed
							? "toolFallbackFailed"
							: partialReasonForShadowFailure(error),
				};
				await runtime.retireFailedShadowSession(state);
			}
		} else {
			files = fallbackFiles(active, fallback);
			tracking =
				fallback.failureCode !== null || active.toolTrackingFailed
					? {
							status: "partial",
							reason: "toolFallbackFailed",
						}
					: active.tracking.status === "partial"
						? active.tracking
						: {
								status: "partial",
								reason: "shadowCaptureFailed",
							};
		}

		let after = null;
		try {
			after = await runtime.capture(ref.cwd);
		} catch {
			// The persisted A to B patch stays exact; workspace Git metadata can
			// refresh independently on the next snapshot.
		}
		if (after !== null && state.baseline.isRepository !== after.isRepository) {
			state.baseline = withoutPatches(after);
			state.turns = [];
		}
		const turn = {
			id: active.id,
			startedAt: active.startedAt,
			endedAt: timestamp,
			beforeHeadSha: active.beforeHeadSha,
			afterHeadSha: after?.headSha ?? active.beforeHeadSha,
			userMessageEntryId: context?.userMessageEntryId ?? active.userMessageEntryId,
			tracking,
			files,
		};
		// Keep empty turns so the turn scope cannot expose an older request.
		state.turns.push(turn);
		try {
			await persist(state);
		} catch (error) {
			if (state.turns.at(-1) === turn) state.turns.pop();
			throw error;
		} finally {
			// Persistence failure is reported to the run but must not strand the
			// active-turn fence.
			state.activeTurn = undefined;
			state.computed = undefined;
		}
	};

	const start = async (ref: SessionRef, timestamp: number, context: PiTurnContext): Promise<void> => {
		const state = await runtime.ensureState(ref);
		if (state.activeTurn) {
			await finalizeActiveTurn(state, ref, timestamp, {
				files: [],
				failureCode: null,
			});
		}
		// These are independent whole-project scans. Observe the shadow rejection
		// immediately while the workspace capture proceeds in parallel.
		const shadowStart = runtime.ensureShadowSession(state).start();
		void shadowStart.catch(() => {});
		const before = await runtime.capture(ref.cwd);
		await runtime.alignRepositoryMode(state, before);

		let shadowCheckpoint = null;
		let tracking: ChangeReviewTrackingState = {
			status: "capturing",
		};
		try {
			shadowCheckpoint = await shadowStart;
		} catch (error) {
			log.warn(`Initial change capture failed for ${ref.sessionId}; using file-tool changes:`, error);
			tracking = {
				status: "partial",
				reason: partialReasonForShadowFailure(error),
			};
			await runtime.retireFailedShadowSession(state);
		}
		state.activeTurn = {
			id: turnId(timestamp),
			startedAt: timestamp,
			beforeHeadSha: before.headSha,
			userMessageEntryId: context.userMessageEntryId,
			shadowCheckpoint,
			tracking,
			trackedFiles: new Map(),
			preview: null,
			toolTrackingFailed: false,
		};
		state.computed = undefined;
	};

	const finish = async (
		ref: SessionRef,
		timestamp: number,
		fallback: PiTurnFallbackCapture,
		context: PiTurnContext,
	): Promise<void> => {
		const state = await runtime.ensureState(ref);
		if (!state.activeTurn) return;
		await state.watcher?.waitForIdle();
		await finalizeActiveTurn(state, ref, timestamp, fallback, context);
	};

	const recordFileUpdate = async (
		ref: SessionRef,
		event: Extract<SessionRuntimeChangeReviewEvent, { type: "changeReviewFileUpdated" }>,
	): Promise<boolean> => {
		const state = await runtime.ensureState(ref);
		const active = state.activeTurn;
		if (!active || active.toolTrackingFailed) return false;
		if (event.file === null) {
			active.trackedFiles.delete(event.path);
		} else {
			active.trackedFiles.set(event.path, event.file);
		}
		state.computed = undefined;
		return true;
	};

	const recordTrackingFailure = async (ref: SessionRef): Promise<boolean> => {
		const state = await runtime.ensureState(ref);
		const active = state.activeTurn;
		if (!active) return false;
		active.toolTrackingFailed = true;
		if (active.shadowCheckpoint === null || active.tracking.status === "partial") {
			active.tracking = {
				status: "partial",
				reason: "toolFallbackFailed",
			};
		}
		state.computed = undefined;
		return true;
	};

	return {
		turnLifecycleHost: {
			start: (ref, timestamp, context) =>
				runtime.runForOpenProjectSession(ref, (canonicalRef) => start(canonicalRef, timestamp, context)),
			finish: (ref, timestamp, fallback, context) =>
				runtime.runForOpenProjectSession(ref, (canonicalRef) => finish(canonicalRef, timestamp, fallback, context)),
		},
		recordFileUpdate: (ref, event) =>
			runtime.runForOpenProjectSession(ref, (canonicalRef) => recordFileUpdate(canonicalRef, event)),
		recordTrackingFailure: (ref) => runtime.runForOpenProjectSession(ref, recordTrackingFailure),
	};
}
