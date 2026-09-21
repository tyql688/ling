import { motion } from "motion/react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { ChevronDown, ChevronUp } from "lucide-react";
import { EmptyState } from "@renderer/components/ui/empty-state";
import type { SessionQueue, SummarizationRetryStatus } from "@ling/contracts/session";
import type { ExtensionUiStateSnapshot } from "@ling/contracts/session-extension-ui";
import type { SessionMessage } from "@ling/contracts/session-messages";
import { parseSessionKey } from "@ling/contracts/session-ref";
import { ErrorBoundary } from "@renderer/components/error-boundary";
import { InlineErrorFallback } from "@renderer/components/error-fallback";
import { createMarkdownFileMentions, MarkdownFileMentionsContext } from "@renderer/components/markdown-file-mentions";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import type { ChangeReviewTurn } from "@renderer/features/review/turn-changes-card";
import {
	peekSessionScrollMemory,
	resolvePinnedScrollTop,
	resolveScrollTarget,
	type TranscriptViewportPin,
} from "@renderer/features/sessions/runtime/transcript-scroll-memory";
import { sessionAutoRetryFamily } from "@renderer/features/sessions/state/session";
import { useStableCallback } from "@renderer/hooks/use-stable-callback";
import Ansi from "ansi-to-react";
import { useAtomValue } from "jotai";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { isResolvedByLaterCompaction } from "./compaction-errors";
import { projectExtensionTerminalText } from "../extension-ui/extension-terminal-text";
import { ExtensionTranscriptHeader, ExtensionWorkingIndicator } from "../extension-ui/extension-ui-surface";
import { type QueueActions, QueuedBubble } from "../composer/queued-bubble";
import { SessionImageRefContext } from "./session-image-source";
import {
	computeWorkingStatusKey,
	shouldShowWorkingStatus,
	timelineRowDisplayRevision,
} from "./transcript-activity-model";
import { TranscriptHistoryNotice } from "./transcript-history-notice";
import { transcriptRowId } from "./transcript-row-metrics";
import type { TranscriptRow } from "./transcript-row-model";
import { TranscriptRowView } from "./transcript-row-view";
import { ScrollToBottomButton, TranscriptContent, TranscriptScrollMemory } from "./transcript-rows";
import { createTranscriptScrollRestoration } from "./transcript-scroll-restoration";
import { createTranscriptTimelineProjector } from "./transcript-timeline-projection";
import { createTranscriptVirtualLayout } from "./transcript-virtual-layout";
import { turnChangesRowRevision } from "./turn-change-rows";
import { TurnMinimap } from "./turn-minimap";
import type { TranscriptHistoryLoad } from "./use-transcript-history";
import { VirtualTranscriptRows } from "./virtual-transcript";

interface TimelineLocalState {
	sessionKey: string;
	expandedFoldKeys: ReadonlySet<string>;
	disclosuresByRow: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
	/** Retrying history can prepend rows, so drafts follow stable message identity. */
	userEdit: { rowId: string; draft: string } | null;
}

function createTimelineLocalState(sessionKey: string): TimelineLocalState {
	return {
		sessionKey,
		expandedFoldKeys: new Set(),
		disclosuresByRow: new Map(),
		userEdit: null,
	};
}

function createTimelineSessionResources(sessionKey: string) {
	return {
		projector: createTranscriptTimelineProjector(),
		savedScroll: peekSessionScrollMemory(sessionKey),
		restorePending: true,
		disposeRestoration: null as (() => void) | null,
		viewportPin: null as TranscriptViewportPin | null,
		virtualLayout: createTranscriptVirtualLayout(),
	};
}

function TimelineSessionStickState({ sessionKey, atBottom }: { sessionKey: string; atBottom: boolean }) {
	const { scrollToBottom, state, stopScroll } = useStickToBottomContext();
	const resetSessionKeyRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (resetSessionKeyRef.current === sessionKey) return;
		resetSessionKeyRef.current = sessionKey;
		// The provider stays mounted across sessions, so cancel animation/inertia that belongs
		// to the previous scrollport before the parent restores this session's saved position.
		delete state.animation;
		delete state.lastScrollTop;
		delete state.ignoreScrollToTop;
		delete state.lastTick;
		state.velocity = 0;
		state.accumulated = 0;
		state.resizeDifference = 0;
		if (atBottom) {
			state.escapedFromLock = false;
			void scrollToBottom({ animation: "instant" });
		} else {
			stopScroll();
		}
	}, [atBottom, scrollToBottom, sessionKey, state, stopScroll]);
	return null;
}

export interface FloatingConversation {
	onFooterHeightChange: (height: number) => void;
	historyOpen: boolean;
	title: string;
	onToggle(): void;
}

interface ChatTimelineProps {
	floating?: FloatingConversation | undefined;
	historyLoad: TranscriptHistoryLoad;
	/** Stable session key; used for scroll memory and switch restoration. */
	sessionKey: string;
	/** False until the first history attempt settles. A failed attempt reveals the loaded
	 * suffix with a retry notice while keeping composer focus and layout stable. */
	transcriptReady: boolean;
	/** Full history is present; aggregate navigation such as the minimap is authoritative. */
	historyReady: boolean;
	/** Whether this timeline renders its own hydration indicator. The workspace pane sets it
	 * false: resume unmounts the timeline, so the pane owns one indicator across both phases. */
	hydrationOverlay?: boolean;
	messages: SessionMessage[];
	busy: boolean;
	summarizationRetry: SummarizationRetryStatus | null;
	toolsExpanded: boolean;
	hiddenThinkingLabel: string | null;
	extensionUi: Pick<ExtensionUiStateSnapshot, "headerLines" | "workingMessage" | "workingVisible" | "workingIndicator">;
	/** Undelivered steering/follow-up texts — rendered as a pinned overlay. */
	queue: SessionQueue;
	/** Completed review turns from the live snapshot; null while a run is in flight. */
	changeReviewTurns: ChangeReviewTurn[] | null;
	/** Requests reverting a turn's file changes; the shell confirms before executing. */
	onRevertTurn: (turnId: string) => void;
	onOpenTurnReview: (turnId: string | null, path?: string) => void;
	/** Opens a file's session-scope diff — the landing for an inline-code path that any
	 * turn in this session changed, so a mention from an older turn still resolves. */
	onOpenSessionFileReview: (path: string) => void;
	queueActions: QueueActions;
	onRetryTurn?: ((entryId: string) => void) | undefined;
	onFork: (forkEntryId: string) => void;
	onEditMessage: (entryId: string, newText: string) => void;
	/** Transient UI anchored above the measured footer instead of assuming a fixed composer height. */
	footerOverlay: ReactNode;
	/** Composer area, rendered sticky INSIDE the scroller so the scrollbar runs the full
	 * card height past it (instead of stopping above the composer). */
	footer: ReactNode;
}

export function ChatTimeline({
	floating,
	historyLoad,
	sessionKey,
	transcriptReady,
	historyReady,
	hydrationOverlay = true,
	messages,
	busy,
	summarizationRetry,
	toolsExpanded,
	hiddenThinkingLabel,
	extensionUi,
	queue,
	changeReviewTurns,
	onRevertTurn,
	onOpenTurnReview,
	onOpenSessionFileReview,
	queueActions,
	onFork,
	onRetryTurn,
	onEditMessage,
	footerOverlay,
	footer,
}: ChatTimelineProps) {
	const { t } = useTranslation();
	const reducedMotion = useReducedMotion();
	const historyHidden = floating !== undefined && !floating.historyOpen;
	const footerRef = useRef<HTMLDivElement>(null);
	const footerOverlayRef = useRef<HTMLDivElement>(null);
	const hasFooterOverlay = footerOverlay !== null;
	const historyToggleRef = useRef<HTMLButtonElement>(null);
	const {
		imageRef,
		userEdit,
		disclosuresByRow,
		reviewTurnsById,
		timelineResources,
		transcriptRows,
		virtualRows,
		tailRows,
		statusRows,
		outline,
		timelineRootRef,
		stickToBottomInitial,
		restoreScroll,
		toggleFold,
		pinViewport,
		updateRowDisclosure,
		stableOpenTurnReview,
		stableRevertTurn,
		stableFork,
		stableRetry,
		fileMentions,
		beginUserEdit,
		changeUserEditDraft,
		cancelUserEdit,
		submitUserEdit,
	} = useTranscriptTimelineState({
		sessionKey,
		transcriptReady,
		messages,
		busy,
		changeReviewTurns,
		onOpenTurnReview,
		onOpenSessionFileReview,
		onRevertTurn,
		onFork,
		onRetryTurn,
		onEditMessage,
	});

	// Every projected row gets a semantic revision so memoized historical rows stay frozen
	// while the active assistant row continues to update during streaming.
	const transcriptRowRevision = (row: TranscriptRow): string =>
		row.kind === "turnFold"
			? `turn-fold:${row.turnKey}:${row.expanded}:${row.durationMs ?? ""}:${row.outcome}:${row.hiddenCount}:${row.failure}:${row.retryEntryId}:${JSON.stringify(row.activity)}`
			: row.kind === "turnChanges"
				? turnChangesRowRevision(row.turnId, reviewTurnsById.get(row.turnId))
				: timelineRowDisplayRevision(row, {
						toolsExpanded,
						hiddenThinkingLabel,
						editingUserRowId: userEdit?.rowId ?? null,
					});

	const renderTranscriptRow = (row: TranscriptRow, rowId: string, revision: string): ReactNode => {
		const isLastMessage = row.kind === "plain" && row.index === messages.length - 1;
		const showAssistantError =
			row.kind === "plain" &&
			row.message.role === "assistant" &&
			row.message.stopReason === "error" &&
			!isResolvedByLaterCompaction(messages, row.index);
		const editDraft =
			row.kind === "plain" && row.message.role === "user" && userEdit?.rowId === rowId ? userEdit.draft : null;
		// Item-level error boundary: the transcript is the only render path driven directly by
		// model output/extension snapshots, so one bad message degrades only its own row; a
		// revision change (streaming update/retry) automatically clears the error state.
		return (
			<ErrorBoundary
				resetKeys={[rowId, revision]}
				fallback={(error, reset) => <InlineErrorFallback error={error} onRetry={reset} />}
			>
				<TranscriptRowView
					row={row}
					rowId={rowId}
					revision={revision}
					busy={busy}
					isLastMessage={isLastMessage}
					showAssistantError={showAssistantError}
					editDraft={editDraft}
					disclosures={disclosuresByRow.get(rowId)}
					reviewTurn={row.kind === "turnChanges" ? reviewTurnsById.get(row.turnId) : undefined}
					toolsExpanded={toolsExpanded}
					hiddenThinkingLabel={hiddenThinkingLabel}
					messages={messages}
					onToggleFold={toggleFold}
					onPinViewport={pinViewport}
					onDisclosureChange={updateRowDisclosure}
					onOpenTurnReview={stableOpenTurnReview}
					onRevertTurn={stableRevertTurn}
					onFork={stableFork}
					onRetryTurn={onRetryTurn ? stableRetry : undefined}
					onBeginUserEdit={beginUserEdit}
					onUserEditDraftChange={changeUserEditDraft}
					onCancelUserEdit={cancelUserEdit}
					onSubmitUserEdit={submitUserEdit}
				/>
			</ErrorBoundary>
		);
	};

	// The transcript owns activity and retry state; the composer edge reflects that same state.
	const autoRetry = useAtomValue(sessionAutoRetryFamily(sessionKey));
	const showWorkingStatus =
		autoRetry !== null || shouldShowWorkingStatus(busy, extensionUi.workingVisible, summarizationRetry);
	const hasWorkingDetails =
		showWorkingStatus &&
		(autoRetry !== null ||
			summarizationRetry !== null ||
			extensionUi.workingMessage !== null ||
			extensionUi.workingIndicator !== null);
	const workingStatusLabel = useMemo((): ReactNode => {
		if (autoRetry !== null) {
			return t("session.autoRetryWaiting", {
				attempt: autoRetry.attempt,
				maxAttempts: autoRetry.maxAttempts,
				error: autoRetry.errorMessage,
			});
		}
		if (summarizationRetry?.phase === "waiting") {
			return t("session.summarizationRetryWaiting", {
				attempt: summarizationRetry.attempt,
				maxAttempts: summarizationRetry.maxAttempts,
			});
		}
		if (summarizationRetry?.phase === "running" && summarizationRetry.source === "branchSummary") {
			return t("session.summarizationRetryBranch");
		}
		if (summarizationRetry?.phase === "running" && summarizationRetry.source === "compaction") {
			return t(summarizationRetry.reason === "overflow" ? "session.compactingOverflow" : "session.compacting");
		}
		if (extensionUi.workingMessage !== null) {
			return <Ansi useClasses>{projectExtensionTerminalText(extensionUi.workingMessage)}</Ansi>;
		}
		return t(computeWorkingStatusKey(statusRows));
	}, [autoRetry, extensionUi.workingMessage, statusRows, summarizationRetry, t]);

	const reportFooterHeight = useStableCallback((height: number) => floating?.onFooterHeightChange(height));
	useLayoutEffect(() => {
		const root = timelineRootRef.current,
			footer = footerRef.current;
		if (!root || !footer) return;
		const measure = () => {
			const height = footer.getBoundingClientRect().height;
			root.style.setProperty("--timeline-footer-height", `${height}px`);
			const overlayHeight = footerOverlayRef.current?.offsetHeight ?? 0;
			const stackHeight = height + (overlayHeight > 0 ? overlayHeight + 8 : 0);
			root.style.setProperty("--timeline-footer-stack-height", `${stackHeight}px`);
			reportFooterHeight(stackHeight);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(footer);
		if (footerOverlayRef.current) observer.observe(footerOverlayRef.current);
		return () => observer.disconnect();
	}, [timelineRootRef, reportFooterHeight, historyHidden, hasFooterOverlay]);
	useLayoutEffect(() => {
		const active = document.activeElement;
		if (historyHidden && active instanceof HTMLElement && active.closest("[data-timeline-rows]"))
			historyToggleRef.current?.focus({ preventScroll: true });
	}, [historyHidden]);

	const toggleFloatingHistory = useStableCallback(() => floating?.onToggle());
	useEffect(() => {
		if (!floating?.historyOpen) return;
		const keydown = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.isComposing ||
				!(event.target instanceof Element) ||
				!timelineRootRef.current?.contains(event.target) ||
				event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')
			)
				return;
			event.preventDefault();
			toggleFloatingHistory();
		};
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	}, [floating?.historyOpen, timelineRootRef, toggleFloatingHistory]);
	return (
		// The inner div is the library's scroll element — vertical only; blocks that need width
		// (code, tables, formulas) scroll inside their own containers instead of panning the
		// whole transcript. break-words keeps long unbreakable tokens (URLs, hashes) wrapping.
		<SessionImageRefContext.Provider value={imageRef}>
			<MarkdownFileMentionsContext.Provider value={fileMentions}>
				<div
					ref={timelineRootRef}
					data-floating-conversation={floating !== undefined || undefined}
					data-history-hidden={historyHidden || undefined}
					className="conversation-timeline relative flex min-h-0 flex-1 flex-col"
				>
					{floating && (
						<motion.div
							aria-hidden
							initial={false}
							animate={{ opacity: historyHidden ? 0 : 1, scaleY: historyHidden ? 0 : 1 }}
							transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
							className="pointer-events-none absolute inset-0 origin-bottom rounded-panel border border-border-subtle bg-surface shadow-[var(--shadow-reading-surface)]"
						/>
					)}
					{floating && (
						<button
							ref={historyToggleRef}
							type="button"
							className="floating-conversation-toggle pointer-events-auto absolute inset-x-0 z-40 flex h-9 items-center gap-2 rounded-control border border-border-subtle bg-surface px-3 text-start text-xs text-text-muted hover:text-text-primary"
							aria-expanded={floating.historyOpen}
							aria-label={t(floating.historyOpen ? "reading.hideHistory" : "reading.showHistory")}
							style={floating.historyOpen ? { top: 0 } : { bottom: "var(--timeline-footer-stack-height, 160px)" }}
							onPointerDown={(event) => event.preventDefault()}
							onClick={floating.onToggle}
						>
							<span className="min-w-0 flex-1 truncate">{busy ? workingStatusLabel : floating.title}</span>
							{floating.historyOpen ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
						</button>
					)}
					{transcriptReady && !historyReady && (
						<div className="transcript-history-notice" inert={historyHidden} aria-hidden={historyHidden}>
							<TranscriptHistoryNotice history={historyLoad} />
						</div>
					)}
					{/* Instant resize keeps streamed content changes out of scroll animations. */}
					<StickToBottom
						initial={stickToBottomInitial}
						resize="instant"
						className="transcript-viewport relative min-h-0 flex-1"
					>
						<TimelineSessionStickState
							sessionKey={sessionKey}
							atBottom={timelineResources.savedScroll?.atBottom !== false}
						/>
						<TranscriptScrollMemory
							sessionKey={sessionKey}
							layout={timelineResources.virtualLayout}
							interactionRootRef={timelineRootRef}
						/>
						{/* scrollClassName lands on the library's scroll element itself — vertical only;
			    wide blocks (code, tables) scroll inside their own containers instead of
			    panning the transcript. min-h-full lets mt-auto dock the sticky footer to the
			    card bottom even when the transcript is shorter than the viewport. */}
						<TranscriptContent historyHidden={historyHidden}>
							<div className="transcript-extension-header" inert={historyHidden} aria-hidden={historyHidden}>
								<ExtensionTranscriptHeader lines={extensionUi.headerLines} />
							</div>
							<div
								className="timeline flex flex-col"
								data-timeline-rows=""
								inert={historyHidden}
								aria-hidden={historyHidden}
								role="log"
								aria-label={t("session.conversationLog")}
								aria-busy={busy}
							>
								{transcriptReady && transcriptRows.length === 0 && !busy && (
									<EmptyState variant="inline" title={t("session.empty")} />
								)}
								{/* The first attempt settles before rows mount. A failed page still reveals
							    the complete suffix and any earlier pages already read. */}
								{transcriptReady && (
									<VirtualTranscriptRows
										key={sessionKey}
										sessionKey={sessionKey}
										initialScrollTop={timelineResources.savedScroll?.scrollTop ?? 0}
										onLayoutReady={restoreScroll}
										rows={virtualRows}
										tailRows={tailRows}
										layout={timelineResources.virtualLayout}
										renderRow={(row) => {
											const rowId = transcriptRowId(row);
											return renderTranscriptRow(row, rowId, transcriptRowRevision(row));
										}}
									/>
								)}
							</div>
							{/* Sticky INSIDE StickToBottom.Content — the library renders any other children
				    in its outer (non-scrolling) wrapper, where sticky silently degrades into an
				    overlay that hides the transcript's tail and the scrollbar's bottom. In here
				    it occupies real scroll space, so the last message always clears the composer
				    and the scrollbar track runs the full card height. mt-auto docks it to the
				    bottom on short transcripts. Messages and composer share the same responsive
				    side gutters. The sticky box is a positioned ancestor, so the
				    jump-to-bottom button floats just above it. The top padding keeps a full
				    spacing step between the last tool row and the composer in every activity state. */}
							<div
								ref={footerRef}
								data-timeline-footer=""
								data-workbench-fixed-footer=""
								data-composer-working={showWorkingStatus ? "true" : undefined}
								className="pointer-events-auto sticky bottom-0 z-20 mt-auto pt-4"
							>
								{!historyHidden && <ScrollToBottomButton lifted={footerOverlay !== null || hasWorkingDetails} />}
								{footerOverlay !== null && (
									<div
										ref={footerOverlayRef}
										className="pointer-events-none absolute inset-x-0 bottom-full z-30 mb-2 flex justify-center [&>*]:pointer-events-auto"
									>
										{footerOverlay}
									</div>
								)}
								{/* Generic activity is announced without an extra row; retries and extension copy stay visible. */}
								{showWorkingStatus ? (
									<div className={hasWorkingDetails ? "w-full px-6 pb-1 pt-1" : "sr-only"}>
										<div
											className="flex h-7 min-w-0 items-center gap-2 text-sm text-text-muted"
											role="status"
											aria-live="polite"
										>
											{hasWorkingDetails && <ExtensionWorkingIndicator indicator={extensionUi.workingIndicator} />}
											<span className="min-w-0 truncate leading-5">{workingStatusLabel}</span>
										</div>
									</div>
								) : null}
								{footer}
							</div>
						</TranscriptContent>
						{/* Overlay, never a flow child: the gate's scroll height belongs to the reserve block.
				    Sits below the sticky footer so the composer stays visible while hydrating. */}
						{hydrationOverlay && !transcriptReady && (
							<LoadingTransition
								label={t("session.loadingTranscript")}
								size="lg"
								className="pointer-events-none absolute inset-0 min-h-0 bg-loading-veil px-6"
							/>
						)}
						{/* Pending queue, PINNED to the top of the conversation viewport — it must not
				    scroll away with the streaming transcript. Steering delivers first. */}
						{(queue.steering.length > 0 || queue.followUp.length > 0) && (
							<div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex w-full flex-col items-end gap-1.5 px-6">
								{queue.steering.map((message, index) => (
									<QueuedBubble
										// eslint-disable-next-line react/no-array-index-key -- queue order is the identity here
										key={`steer-${index}`}
										message={message}
										kind="steering"
										index={index}
										queueRevision={queue.revision}
										actions={queueActions}
									/>
								))}
								{queue.followUp.map((message, index) => (
									<QueuedBubble
										// eslint-disable-next-line react/no-array-index-key -- queue order is the identity here
										key={`followup-${index}`}
										message={message}
										kind="followUp"
										index={index}
										queueRevision={queue.revision}
										actions={queueActions}
									/>
								))}
							</div>
						)}
						{transcriptReady && historyReady && !historyHidden && (
							<TurnMinimap outline={outline} layout={timelineResources.virtualLayout} />
						)}
					</StickToBottom>
				</div>
			</MarkdownFileMentionsContext.Provider>
		</SessionImageRefContext.Provider>
	);
}

/** Session-scoped projection, editing and scroll resources share one cleanup lifetime. */
function useTranscriptTimelineState({
	sessionKey,
	transcriptReady,
	messages,
	busy,
	changeReviewTurns,
	onOpenTurnReview,
	onOpenSessionFileReview,
	onRevertTurn,
	onFork,
	onRetryTurn,
	onEditMessage,
}: Pick<
	ChatTimelineProps,
	| "sessionKey"
	| "transcriptReady"
	| "messages"
	| "busy"
	| "changeReviewTurns"
	| "onOpenTurnReview"
	| "onOpenSessionFileReview"
	| "onRevertTurn"
	| "onFork"
	| "onRetryTurn"
	| "onEditMessage"
>) {
	// The transcript addresses its own session when it builds attachment URLs.
	const imageRef = useMemo(() => parseSessionKey(sessionKey), [sessionKey]);
	const [localState, setLocalState] = useState<TimelineLocalState>(() => createTimelineLocalState(sessionKey));
	const activeLocalState = localState.sessionKey === sessionKey ? localState : createTimelineLocalState(sessionKey);
	const { expandedFoldKeys, disclosuresByRow, userEdit } = activeLocalState;
	useLayoutEffect(() => {
		setLocalState((current) => (current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey)));
	}, [sessionKey]);
	const toggleFold = useCallback(
		(turnKey: string, expanded: boolean) => {
			setLocalState((current) => {
				const active = current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey);
				if (active.expandedFoldKeys.has(turnKey) === expanded) return active;
				const next = new Set(active.expandedFoldKeys);
				if (expanded) next.add(turnKey);
				else next.delete(turnKey);
				return { ...active, expandedFoldKeys: next };
			});
		},
		[sessionKey],
	);
	// The review hook nulls its snapshot while a run is in flight; holding the last
	// non-null turns keeps historical cards from flickering out during each new turn.
	const heldTurnsRef = useRef<{ sessionKey: string; turns: readonly ChangeReviewTurn[] }>({
		sessionKey,
		turns: [],
	});
	useEffect(() => {
		if (changeReviewTurns !== null) heldTurnsRef.current = { sessionKey, turns: changeReviewTurns };
		else if (heldTurnsRef.current.sessionKey !== sessionKey) heldTurnsRef.current = { sessionKey, turns: [] };
	}, [changeReviewTurns, sessionKey]);

	// eslint-disable-next-line react-hooks/exhaustive-deps -- the dependency is deliberately the narrowed value, not the expression it came from
	const reviewTurns =
		changeReviewTurns ?? (heldTurnsRef.current.sessionKey === sessionKey ? heldTurnsRef.current.turns : []);
	const reviewTurnsById = useMemo(() => new Map(reviewTurns.map((turn) => [turn.id, turn])), [reviewTurns]);
	// Each session owns an isolated projector and scroll resources. Switching sessions
	// replaces this object atomically, without remounting the full conversation subtree.
	const timelineResources = useMemo(() => createTimelineSessionResources(sessionKey), [sessionKey]);
	useLayoutEffect(
		() => () => {
			timelineResources.disposeRestoration?.();
			timelineResources.disposeRestoration = null;
			// StrictMode replays attachment after cleanup using the same session resources.
			timelineResources.restorePending = true;
		},
		[timelineResources],
	);
	const projection = useMemo(
		() => timelineResources.projector.project(messages, busy, reviewTurns, expandedFoldKeys),
		[busy, expandedFoldKeys, messages, reviewTurns, timelineResources],
	);
	const { transcriptRows, virtualRows, tailRows, statusRows, outline } = projection;
	const timelineRootRef = useRef<HTMLDivElement | null>(null);
	// A saved mid-transcript position must not be overwritten by the library's mount-time
	// bottom scroll, so opt out of `initial` entirely there.
	const stickToBottomInitial = timelineResources.savedScroll?.atBottom === false ? false : ("instant" as const);
	const restoreScroll = useCallback(
		(scroller: HTMLElement) => {
			if (!timelineResources.restorePending) return;
			timelineResources.restorePending = false;
			const saved = timelineResources.savedScroll;
			const restoredByVirtualRow =
				saved?.atBottom === false &&
				saved.anchorRowId !== null &&
				timelineResources.virtualLayout.jumpToRow(saved.anchorRowId, saved.anchorOffsetPx);
			if (!restoredByVirtualRow) scroller.scrollTop = resolveScrollTarget(saved, scroller);
			const interactionRoot = timelineRootRef.current;
			if (saved?.atBottom === false && interactionRoot) {
				timelineResources.disposeRestoration = createTranscriptScrollRestoration({
					scroller,
					interactionRoot,
					layout: timelineResources.virtualLayout,
					saved,
				});
			}
		},
		[timelineResources],
	);

	const pinViewport = useCallback(
		(pin: TranscriptViewportPin) => {
			timelineResources.viewportPin = pin;
		},
		[timelineResources],
	);
	const updateRowDisclosure = useCallback(
		(rowId: string, key: string, expanded: boolean) => {
			setLocalState((current) => {
				const active = current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey);
				const currentRow = active.disclosuresByRow.get(rowId);
				if (currentRow?.get(key) === expanded) return active;
				const nextRow = new Map(currentRow);
				nextRow.set(key, expanded);
				const next = new Map(active.disclosuresByRow);
				next.set(rowId, nextRow);
				return { ...active, disclosuresByRow: next };
			});
		},
		[sessionKey],
	);

	useEffect(() => {
		const knownIds = new Set(transcriptRows.map(transcriptRowId));
		const knownFoldKeys = new Set(transcriptRows.flatMap((row) => (row.kind === "turnFold" ? [row.turnKey] : [])));
		setLocalState((current) => {
			const active = current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey);
			let nextExpanded: Set<string> | null = null;
			for (const key of active.expandedFoldKeys) {
				if (knownFoldKeys.has(key)) continue;
				if (nextExpanded === null) nextExpanded = new Set(active.expandedFoldKeys);
				nextExpanded.delete(key);
			}
			let next: Map<string, ReadonlyMap<string, boolean>> | null = null;
			for (const id of active.disclosuresByRow.keys()) {
				if (knownIds.has(id)) continue;
				if (next === null) next = new Map(active.disclosuresByRow);
				next.delete(id);
			}
			const nextUserEdit = active.userEdit === null || knownIds.has(active.userEdit.rowId) ? active.userEdit : null;
			if (nextExpanded === null && next === null && nextUserEdit === active.userEdit && active === current)
				return current;
			return {
				...active,
				expandedFoldKeys: nextExpanded ?? active.expandedFoldKeys,
				disclosuresByRow: next ?? active.disclosuresByRow,
				userEdit: nextUserEdit,
			};
		});
	}, [sessionKey, transcriptRows]);

	// Fold toggles publish a one-render pin; session restoration waits for the virtualizer
	// to attach and measure its scroll margin before consuming the saved position.
	useLayoutEffect(() => {
		const scroller = timelineRootRef.current?.querySelector(".chat-timeline-scroll");
		if (!(scroller instanceof HTMLElement)) return;
		if (!transcriptReady) return;

		const pin = timelineResources.viewportPin;
		if (pin !== null) {
			timelineResources.viewportPin = null;
			const pinnedByVirtualRow = timelineResources.virtualLayout.jumpToRow(pin.rowId, pin.offsetPx);
			const pinned = pinnedByVirtualRow ? null : resolvePinnedScrollTop(scroller, pin);
			if (!pinnedByVirtualRow && pinned !== null) {
				const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
				scroller.scrollTop = Math.min(maxScroll, pinned);
			}
		}
	});

	// Stable identities so memoized rows never re-render because a parent closure was
	// recreated; invocations still reach the latest implementation (use-stable-callback).
	const stableOpenTurnReview = useStableCallback(onOpenTurnReview);
	const stableOpenSessionFileReview = useStableCallback(onOpenSessionFileReview);
	const stableRevertTurn = useStableCallback(onRevertTurn);
	const stableFork = useStableCallback(onFork);
	const stableRetry = useStableCallback((entryId: string) => onRetryTurn?.(entryId));
	// Every file this session's turns changed, so prose naming a file an earlier turn wrote
	// still resolves; the session scope is the one that holds all of them.
	const fileMentions = useMemo(() => {
		const paths = reviewTurns.flatMap((turn) => turn.summary.files.map((file) => file.path));
		if (paths.length === 0) return null;
		return createMarkdownFileMentions(paths, stableOpenSessionFileReview);
	}, [reviewTurns, stableOpenSessionFileReview]);
	const beginUserEdit = useCallback(
		(rowId: string, text: string) =>
			setLocalState((current) => {
				const active = current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey);
				return { ...active, userEdit: { rowId, draft: text } };
			}),
		[sessionKey],
	);
	const changeUserEditDraft = useCallback(
		(rowId: string, draft: string) =>
			setLocalState((current) => {
				const active = current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey);
				return active.userEdit?.rowId === rowId ? { ...active, userEdit: { rowId, draft } } : active;
			}),
		[sessionKey],
	);
	const cancelUserEdit = useCallback(
		(rowId: string) =>
			setLocalState((current) => {
				const active = current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey);
				return active.userEdit?.rowId === rowId ? { ...active, userEdit: null } : active;
			}),
		[sessionKey],
	);
	const submitUserEdit = useStableCallback((entryId: string, newText: string) => {
		setLocalState((current) => {
			const active = current.sessionKey === sessionKey ? current : createTimelineLocalState(sessionKey);
			return { ...active, userEdit: null };
		});
		onEditMessage(entryId, newText);
	});

	return {
		imageRef,
		userEdit,
		disclosuresByRow,
		reviewTurnsById,
		timelineResources,
		transcriptRows,
		virtualRows,
		tailRows,
		statusRows,
		outline,
		timelineRootRef,
		stickToBottomInitial,
		restoreScroll,
		toggleFold,
		pinViewport,
		updateRowDisclosure,
		stableOpenTurnReview,
		stableRevertTurn,
		stableFork,
		stableRetry,
		fileMentions,
		beginUserEdit,
		changeUserEditDraft,
		cancelUserEdit,
		submitUserEdit,
	};
}
