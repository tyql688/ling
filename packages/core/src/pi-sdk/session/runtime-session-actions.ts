import type { MessageFileReference } from "@ling/contracts/file-reference-text";
import type { ImageAttachment } from "@ling/contracts/session";
import { throwAggregateFailures } from "../../ling-error";
import { createLogger } from "../../logger";
import type { PiAgentSession } from "../types";
import type { PiQueueKind, PiQueueMirror } from "./queue-mirror";
import type { PiRuntimeOperationCoordinator } from "./runtime-operations";

const log = createLogger("pi-sdk");

type NavigateTreeOptions = Parameters<PiAgentSession["navigateTree"]>[1];
type NavigateTreeResult = Awaited<ReturnType<PiAgentSession["navigateTree"]>>;

interface RuntimeSessionActionHost {
	getSession(): PiAgentSession;
	operations: Pick<PiRuntimeOperationCoordinator, "run" | "runPrompt">;
	queueMirror(sessionId: string): PiQueueMirror;
	emitTreeNavigation(): void;
}

type AbortOutcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };
type QueuePromotionAdmission = { committed: boolean };

interface ManualCompactionState {
	abortRequested: boolean;
	observedStart: boolean;
	observedEnd: boolean;
	aborted: boolean;
	abortAfterStart: Promise<AbortOutcome> | null;
	queuePromotionAdmission: Promise<QueuePromotionAdmission> | null;
	startOrSettled: Promise<void>;
	markStartedOrSettled(): void;
	settled: Promise<void>;
	markSettled(): void;
}

function createManualCompactionState(): ManualCompactionState {
	const { promise: startOrSettled, resolve: markStartedOrSettled } = Promise.withResolvers<void>();
	const { promise: settled, resolve: markSettled } = Promise.withResolvers<void>();
	return {
		abortRequested: false,
		observedStart: false,
		observedEnd: false,
		aborted: false,
		abortAfterStart: null,
		queuePromotionAdmission: null,
		startOrSettled,
		markStartedOrSettled,
		settled,
		markSettled,
	};
}

function captureAbort(session: PiAgentSession): Promise<AbortOutcome> {
	return session.abort().then(
		() => ({ status: "fulfilled" }),
		(error: unknown) => ({ status: "rejected", error }),
	);
}

interface PiRuntimeSessionActions {
	sendPrompt(text: string, images?: ImageAttachment[]): Promise<void>;
	steer(text: string, images?: ImageAttachment[], fileReferences?: MessageFileReference[]): Promise<void>;
	followUp(text: string, images?: ImageAttachment[], fileReferences?: MessageFileReference[]): Promise<void>;
	editQueuedMessage(
		kind: PiQueueKind,
		index: number,
		expectedText: string,
		text: string | null,
		images?: ImageAttachment[],
		fileReferences?: MessageFileReference[],
	): Promise<void>;
	promoteQueuedMessage(index: number, expectedText: string): Promise<void>;
	abort(): Promise<{ restoredTexts: string[] }>;
	compact(customInstructions?: string): Promise<void>;
	navigateTree(targetId: string, options?: NavigateTreeOptions): Promise<NavigateTreeResult>;
}

/** Messages queued while a manual compaction ran have no agent run to drain them.
 * Mirror the Pi CLI: promote the first queued message to a fresh prompt; the new run
 * then delivers the rest through the normal steering/follow-up queues. Never lets a
 * flush problem mask the compaction result — bootstrap errors are logged, not thrown. */
function flushQueueAfterCompaction(
	host: RuntimeSessionActionHost,
	session: PiAgentSession,
	state: ManualCompactionState,
): void {
	try {
		if (state.abortRequested || !session.isIdle) return;
		const mirror = host.queueMirror(session.sessionManager.getSessionId());
		const queue = mirror.project();
		const first = queue.steering[0]
			? { kind: "steering" as const, message: queue.steering[0] }
			: queue.followUp[0]
				? { kind: "followUp" as const, message: queue.followUp[0] }
				: null;
		if (!first) return;
		const { promise: admission, resolve: resolveAdmission } = Promise.withResolvers<QueuePromotionAdmission>();
		state.queuePromotionAdmission = admission;
		let admissionSettled = false;
		const settleAdmission = (committed: boolean): void => {
			if (admissionSettled) return;
			admissionSettled = true;
			resolveAdmission({ committed });
		};
		void host.operations
			.runPrompt(() =>
				promoteQueuedPrompt(session, mirror, first.kind, first.message, () => !state.abortRequested, settleAdmission),
			)
			.catch((error) => {
				log.error(`Failed to deliver queued message after compaction (${JSON.stringify(first.message.text)}):`, error);
			})
			.finally(() => settleAdmission(false));
	} catch (error) {
		log.error("Queued-message flush after compaction could not start:", error);
	}
}

async function promoteQueuedPrompt(
	session: PiAgentSession,
	mirror: PiQueueMirror,
	kind: PiQueueKind,
	message: { text: string; images: readonly ImageAttachment[]; fileReferences: readonly MessageFileReference[] },
	canStart: () => boolean,
	settleAdmission: (committed: boolean) => void,
): Promise<void> {
	// preflightResult(true) fires when Pi commits the message for delivery; from then on
	// a turn failure must NOT restore the message (it was delivered — restoring would
	// duplicate it). Before that point the prompt never happened, so restore in place.
	let committed = false;
	let removed = false;
	try {
		if (!canStart()) return;
		await mirror.edit(kind, 0, message.text, null);
		removed = true;
		if (!canStart()) {
			await mirror.restoreFront(kind, message.text, message.images, message.fileReferences);
			removed = false;
			return;
		}
		await session.prompt(message.text, {
			source: "interactive",
			// If a run started meanwhile, queue instead of throwing "already processing".
			streamingBehavior: kind === "steering" ? "steer" : "followUp",
			...(message.images.length > 0 ? { images: [...message.images] } : {}),
			preflightResult: (ok: boolean) => {
				committed = ok;
				if (ok) settleAdmission(true);
			},
		});
	} catch (error) {
		if (removed && !committed) {
			await mirror.restoreFront(kind, message.text, message.images, message.fileReferences);
			removed = false;
		}
		throw error;
	} finally {
		settleAdmission(committed);
	}
}

export function createPiRuntimeSessionActions(host: RuntimeSessionActionHost): PiRuntimeSessionActions {
	let manualCompaction: ManualCompactionState | null = null;
	return {
		sendPrompt(text, images) {
			return host.operations.runPrompt(() =>
				host.getSession().prompt(text, {
					source: "interactive",
					...(images ? { images } : {}),
				}),
			);
		},
		steer: (text, images, fileReferences) =>
			host.operations.run(() => {
				const sessionId = host.getSession().sessionManager.getSessionId();
				return host.queueMirror(sessionId).enqueue("steering", text, images, fileReferences);
			}),
		followUp: (text, images, fileReferences) =>
			host.operations.run(() => {
				const sessionId = host.getSession().sessionManager.getSessionId();
				return host.queueMirror(sessionId).enqueue("followUp", text, images, fileReferences);
			}),
		editQueuedMessage: (kind, index, expectedText, text, images, fileReferences) =>
			host.operations.run(() => {
				const sessionId = host.getSession().sessionManager.getSessionId();
				return host.queueMirror(sessionId).edit(kind, index, expectedText, text, images, fileReferences);
			}),
		promoteQueuedMessage: (index, expectedText) =>
			host.operations.run(() => {
				const sessionId = host.getSession().sessionManager.getSessionId();
				return host.queueMirror(sessionId).promote(index, expectedText);
			}),
		abort() {
			return host.operations.run(async () => {
				const session = host.getSession();
				const compaction = manualCompaction;
				if (compaction) compaction.abortRequested = true;
				// Aborting ends the turn, so queued steer/follow-up messages cannot
				// remain armed for the next run. Return their text to the editor.
				const cleared = session.clearQueue();
				// Pi owns cancellation of the agent run, retry, compaction, and branch summary.
				const failures: unknown[] = [];
				try {
					await session.abort();
				} catch (error) {
					failures.push(error);
				}
				if (compaction) {
					// AgentSession.compact() awaits its own abort before it creates the manual
					// compaction controller. If stop arrived in that gap, wait for the start
					// listener to cancel the newly created controller, then for compact() to settle.
					await compaction.startOrSettled;
					if (compaction.abortAfterStart) {
						const outcome = await compaction.abortAfterStart;
						if (outcome.status === "rejected") failures.push(outcome.error);
					}
					await compaction.settled;
					const promotionAdmission = compaction.queuePromotionAdmission;
					if (promotionAdmission) {
						const promotion = await promotionAdmission;
						if (promotion.committed) {
							const outcome = await captureAbort(session);
							if (outcome.status === "rejected") failures.push(outcome.error);
						}
					}
				}
				// A concurrent steering/follow-up request can arrive while abort() waits for
				// Pi's provider or compaction work to settle. Clear that second wave before
				// reporting the stop as complete so no cancelled-turn input leaks into the
				// next prompt.
				const lateCleared = session.clearQueue();
				throwAggregateFailures(failures, "Failed to abort the Pi session and manual compaction");
				return {
					restoredTexts: [...cleared.steering, ...cleared.followUp, ...lateCleared.steering, ...lateCleared.followUp],
				};
			});
		},
		compact(customInstructions) {
			if (manualCompaction) return Promise.reject(new Error("Manual compaction is already in progress"));
			// Register before the operation callback reaches its first microtask. Stop may
			// otherwise run in the gap after compact() was requested but before Pi creates
			// and announces its manual-compaction AbortController.
			const state = createManualCompactionState();
			manualCompaction = state;
			const operation = host.operations.run(async () => {
				const session = host.getSession();
				let unsubscribe: (() => void) | null = null;
				try {
					unsubscribe = session.subscribe((event) => {
						if (event.type === "compaction_start" && event.reason === "manual" && !state.observedStart) {
							state.observedStart = true;
							state.markStartedOrSettled();
							if (state.abortRequested) state.abortAfterStart = captureAbort(session);
							return;
						}
						if (
							event.type === "compaction_end" &&
							event.reason === "manual" &&
							state.observedStart &&
							!state.observedEnd
						) {
							state.observedEnd = true;
							state.aborted = event.aborted;
						}
					});
					try {
						await session.compact(customInstructions);
					} catch (error) {
						// Pi emits the structured outcome before compact() rejects. A stop
						// during manual compaction is neutral; every actual failure rethrows
						// and never promotes queued work into an over-limit context.
						if (state.abortRequested && state.observedEnd && state.aborted) return;
						throw error;
					}
					// Auto-compaction inside a run delivers queued messages via
					// agent.continue(); manual compaction has no run, so Ling owns the
					// flush — same contract as the CLI's flushCompactionQueue.
					flushQueueAfterCompaction(host, session, state);
				} finally {
					unsubscribe?.();
				}
			});
			return operation.finally(async () => {
				// Also settle waiters when the runtime fence rejects before the operation
				// callback starts and therefore no Pi event can be observed.
				state.markStartedOrSettled();
				state.markSettled();
				// Keep stop wired to this compaction until a queued prompt either stays
				// queued or crosses Pi's preflight commit point. The model turn itself is
				// deliberately not awaited here.
				if (state.queuePromotionAdmission) await state.queuePromotionAdmission;
				if (manualCompaction === state) manualCompaction = null;
			});
		},
		navigateTree: (targetId, options) =>
			host.operations.run(async () => {
				const result = await host.getSession().navigateTree(targetId, options);
				if (!result.cancelled) host.emitTreeNavigation();
				return result;
			}),
	};
}
