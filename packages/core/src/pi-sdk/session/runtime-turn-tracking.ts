import { type PiTurnLifecycle, firstUserMessageEntryIdAfter, userMessageEntryIds } from "./turn-lifecycle";
import type { SessionRef } from "@ling/contracts/session";
import { throwAggregateFailures } from "@ling/core/ling-error";
import type { SessionRuntimeChangeReviewEvent } from "@ling/core/pi-protocol/runtime-types";
import type { PiTurnFallbackCapture } from "@ling/core/pi-protocol/turn-review";
import { createLogger } from "../../logger";
import type { PiAgentSession } from "../types";
import { createTurnFileTracker, type TurnFileTracker } from "./turn-file-tracker";

const log = createLogger("pi-runtime-turn-tracking");

export interface PiRuntimeTurnTracking {
	subscribe(listener: (event: SessionRuntimeChangeReviewEvent) => void): () => void;
	bind(cwd: string, session: PiAgentSession, ref: SessionRef): void;
	dispose(): void;
}

export function createPiRuntimeTurnTracking(turnLifecycle: PiTurnLifecycle): PiRuntimeTurnTracking {
	const { bindPiTurnLifecycle, runPiTurnLifecycleFinish, runPiTurnLifecycleStart } = turnLifecycle;

	let tracker: TurnFileTracker | null = null;
	let unbindLifecycle: (() => void) | null = null;
	const listeners = new Set<(event: SessionRuntimeChangeReviewEvent) => void>();

	const emit = (event: SessionRuntimeChangeReviewEvent, ref: SessionRef): void => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (error) {
				log.error(`change review event listener failed for session ${ref.sessionId}:`, error);
			}
		}
	};
	const emitTrackingFailure = (ref: SessionRef): void => {
		emit({ type: "changeReviewTrackingFailed", code: "CAPTURE_FAILED" }, ref);
	};
	const bind = (cwd: string, session: PiAgentSession, ref: SessionRef): void => {
		if (tracker || unbindLifecycle) {
			throw new Error(`Turn tracking is already bound for session ${ref.sessionId}`);
		}
		const nextTracker = createTurnFileTracker(cwd, (event) => emit(event, ref));
		let boundaryActive = false;
		let previousUserEntryIds: ReadonlySet<string> | null = null;
		tracker = nextTracker;
		unbindLifecycle = bindPiTurnLifecycle(session.sessionManager, {
			start: async (timestamp) => {
				// Pi emits a fresh agent_start for automatic retry, compaction recovery,
				// and queued continuation. They remain one Ling run until agent_settled.
				if (boundaryActive) return;
				boundaryActive = true;
				previousUserEntryIds = userMessageEntryIds(session.sessionManager);
				try {
					await nextTracker.startRun();
				} catch (error) {
					log.error(`change review tool fallback could not start for session ${ref.sessionId}:`, error);
					emitTrackingFailure(ref);
				}
				try {
					await runPiTurnLifecycleStart(ref, timestamp, {
						userMessageEntryId: null,
					});
				} catch (error) {
					log.error(`change review turn-start boundary failed for session ${ref.sessionId}:`, error);
					emitTrackingFailure(ref);
				}
			},
			toolCall: (event) => nextTracker.handleToolCall(event),
			toolResult: (event) => nextTracker.handleToolResult(event),
			finish: async (timestamp) => {
				if (!boundaryActive) return;
				let fallback: PiTurnFallbackCapture;
				try {
					fallback = await nextTracker.finishRun();
				} catch (error) {
					log.error(`change review tool fallback could not finish for session ${ref.sessionId}:`, error);
					emitTrackingFailure(ref);
					fallback = { files: [], failureCode: "CAPTURE_FAILED" };
				}
				try {
					await runPiTurnLifecycleFinish(ref, timestamp, fallback, {
						userMessageEntryId:
							previousUserEntryIds === null
								? null
								: firstUserMessageEntryIdAfter(session.sessionManager, previousUserEntryIds),
					});
				} catch (error) {
					log.error(`change review turn-end boundary failed for session ${ref.sessionId}:`, error);
					emitTrackingFailure(ref);
				} finally {
					boundaryActive = false;
					previousUserEntryIds = null;
				}
			},
		});
	};
	const dispose = (): void => {
		const failures: unknown[] = [];
		const unbind = unbindLifecycle;
		unbindLifecycle = null;
		if (unbind) {
			try {
				unbind();
			} catch (error) {
				failures.push(error);
			}
		}
		const activeTracker = tracker;
		tracker = null;
		if (activeTracker) {
			try {
				activeTracker.dispose();
			} catch (error) {
				failures.push(error);
			}
		}
		throwAggregateFailures(failures, "Failed to dispose Pi runtime turn tracking");
	};

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		bind,
		dispose,
	};
}
