import { Button } from "@renderer/components/ui/button";
import { activitySummary } from "./activity-summary";
import { SESSION_MESSAGE_TEXT_MAX_CHARS } from "@ling/contracts/session";
import type { SessionMessage } from "@ling/contracts/session-messages";
import { parseReviewCommentSegments } from "@ling/contracts/draft-review-comments";
import { ImagePreviewDialog, type PreviewImage } from "@renderer/components/image-preview-dialog";
import { Markdown } from "@renderer/components/markdown";
import { MarkdownImageRootContext } from "@renderer/components/markdown-image-root";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { partsText } from "@renderer/features/chat/transcript/message-text";
import {
	saveSessionScrollMemorySnapshot,
	type TranscriptViewportPin,
} from "@renderer/features/sessions/runtime/transcript-scroll-memory";
import { EMPTY_DRAFT } from "@renderer/features/sessions/state/drafts";
import { submitMessageText } from "@renderer/features/sessions/state/message-text";
import { useBoundedTextInput } from "@renderer/hooks/use-bounded-text-input";
import { cn } from "@renderer/lib/utils";
import { AlertCircle, ArrowDown, ChevronRight, MessageSquareText, Pencil } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type ReactNode,
	type WheelEvent as ReactWheelEvent,
	type RefObject,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ComposerInput } from "../composer/composer-surface";
import { EXPANDED_DETAIL_SCROLL_CLASS, RenderedTerminalLines } from "./assistant-render";
import { selectCustomMessageRenderedLines } from "./custom-message-lines";
import { type MessageImage, useMessageImages } from "./message-images";
import type { TurnFoldRow } from "./transcript-row-model";
import { preserveViewportAnchorTop, shouldEscapeTranscriptBottomLock } from "./transcript-scroll-policy";
import { createTranscriptScrollTracking } from "./transcript-scroll-tracking";
import type { TranscriptVirtualLayout } from "./transcript-virtual-layout";
import { shouldCollapseUserMessage } from "./user-message-collapse";

/** Where a compaction summarized older history — the messages above it are still shown; the
 * divider only carries the summary the LLM sees in their place. */
function HistorySummaryDivider({ summary, label }: { summary: string; label: string }) {
	return (
		<details>
			<summary className="flex cursor-default list-none items-center gap-3 text-xs text-text-muted [&::-webkit-details-marker]:hidden">
				<span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
				<span className="whitespace-nowrap">{label}</span>
				<span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
			</summary>
			<div
				className={cn(
					"mt-2 whitespace-pre-wrap rounded-panel border border-border-subtle bg-surface-raised/50 p-3 text-xs leading-relaxed text-text-muted",
					EXPANDED_DETAIL_SCROLL_CLASS,
				)}
			>
				{summary}
			</div>
		</details>
	);
}

function formatFoldDuration(durationMs: number): string {
	const totalSeconds = Math.round(durationMs / 1000);
	if (totalSeconds < 60) return `${Math.max(1, totalSeconds)}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = totalSeconds % 60;
		return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Fold row of a settled turn: shows working duration; clicking toggles between "collapse tool activity" and "expand full process". */
export function TurnFoldDivider({
	row,
	busy,
	onRetry,
	onToggle,
	onPinViewport,
}: {
	row: TurnFoldRow;
	busy: boolean;
	onRetry: ((entryId: string) => void) | undefined;
	onToggle: (turnKey: string, expanded: boolean) => void;
	/** Parent owns scrollTop; publish a pin so expand/collapse grows downward in place. */
	onPinViewport: (pin: TranscriptViewportPin) => void;
}) {
	const { t } = useTranslation();
	const { scrollRef, stopScroll } = useStickToBottomContext();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const duration = row.durationMs === null ? null : formatFoldDuration(row.durationMs);
	const label =
		row.outcome === "failed"
			? duration === null
				? t("session.turnFoldFailedNoDuration")
				: t("session.turnFoldFailed", { duration })
			: row.outcome === "stopped"
				? duration === null
					? t("session.turnFoldStoppedNoDuration")
					: t("session.turnFoldStopped", { duration })
				: duration === null
					? t("session.turnFoldWorkedNoDuration")
					: t("session.turnFoldWorked", { duration });

	const handleToggle = () => {
		const scroller = scrollRef.current;
		stopScroll();
		// Pin the timeline row wrapper, not this divider: that is the stable node the parent
		// can find again after the expanded rows have been inserted.
		const anchor = rootRef.current?.closest<HTMLElement>("[data-timeline-row]");
		const rowId = anchor?.dataset.timelineRow;
		if (scroller && anchor && rowId !== undefined) {
			onPinViewport({
				rowId,
				offsetPx: scroller.getBoundingClientRect().top - anchor.getBoundingClientRect().top,
			});
		}
		onToggle(row.turnKey, !row.expanded);
	};

	return (
		<div ref={rootRef} className="border-border-subtle border-b pb-2 pt-1">
			<button
				type="button"
				onClick={handleToggle}
				aria-expanded={row.expanded}
				title={row.expanded ? t("session.turnFoldCollapse") : t("session.turnFoldExpand", { count: row.hiddenCount })}
				className={cn(
					"group/fold flex min-h-6 items-center gap-1 rounded-control px-1 py-0.5 text-xs tabular-nums transition-colors",
					row.outcome === "failed" ? "text-danger hover:text-danger" : "text-text-muted hover:text-text-primary",
				)}
			>
				{row.outcome === "failed" && <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />}
				<span>
					{activitySummary(row.activity, t)}
					{Object.values(row.activity).some((count) => count > 0) && " · "}
					{label}
				</span>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
						row.expanded && "rotate-90",
					)}
					aria-hidden="true"
				/>
			</button>
			{row.outcome === "failed" && (
				<div className="flex items-start gap-3 px-1 pt-1 text-xs text-danger">
					<p className="min-w-0 flex-1 break-words line-clamp-2" title={row.failure ?? undefined}>
						{row.failure ?? t("session.turnError")}
					</p>
					{row.retryEntryId !== null && onRetry && (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (row.retryEntryId !== null) onRetry(row.retryEntryId);
							}}
							className="shrink-0 rounded-control px-2 text-text-primary underline underline-offset-2 disabled:opacity-50"
						>
							{t("session.retry")}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export function CompactionDivider({ summary }: { summary: string }) {
	const { t } = useTranslation();
	return <HistorySummaryDivider summary={summary} label={t("session.compactedDivider")} />;
}

export function BranchSummaryDivider({ summary }: { summary: string }) {
	const { t } = useTranslation();
	return <HistorySummaryDivider summary={summary} label={t("session.branchSummaryDivider")} />;
}

export function ScrollToBottomButton({ lifted }: { lifted: boolean }) {
	const { t } = useTranslation();
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();
	return (
		<AnimatePresence>
			{!isAtBottom && (
				<motion.button
					type="button"
					onClick={() => void scrollToBottom()}
					aria-label={t("session.scrollToBottom")}
					initial={{ opacity: 0, scale: 0.8, y: 6 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.8, y: 6 }}
					transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
					// translate-x is the centering offset; motion owns y/scale, so x stays in the style.
					style={{ x: "-50%" }}
					className={`skin-surface absolute left-1/2 flex size-8 items-center justify-center rounded-full border border-border-strong bg-surface text-text-primary shadow-md transition-[top,background-color] hover:bg-surface-raised ${lifted ? "-top-20" : "-top-12"}`}
				>
					<ArrowDown className="size-4" aria-hidden="true" />
				</motion.button>
			)}
		</AnimatePresence>
	);
}

/**
 * Only writes scroll memory when leaving the session. ChatTimeline restores the position
 * after the virtual layout is ready. This component mounts before StickToBottom.Content,
 * so scrollRef is still null at mount time.
 */
export function TranscriptScrollMemory({
	sessionKey,
	layout,
	interactionRootRef,
}: {
	sessionKey: string;
	layout: TranscriptVirtualLayout;
	interactionRootRef: RefObject<HTMLElement | null>;
}) {
	const { scrollRef, state, scrollToBottom } = useStickToBottomContext();
	useLayoutEffect(() => {
		const key = sessionKey;
		const attach = () => {
			const element = scrollRef.current;
			const interactionRoot = interactionRootRef.current;
			if (!element || !interactionRoot) return false;
			const dispose = createTranscriptScrollTracking({
				scroller: element,
				interactionRoot,
				layout,
				state,
				scrollToBottom,
			});
			return () => {
				saveSessionScrollMemorySnapshot(key, dispose());
			};
		};

		const immediate = attach();
		if (immediate) return immediate;

		// Content mounts after this sibling — retry until the scroller exists, then save on cleanup.
		let disposed = false;
		let teardown: (() => void) | undefined;
		let frame = 0;
		const retry = () => {
			frame = 0;
			if (disposed || teardown) return;
			teardown = attach() || undefined;
			if (!teardown) frame = requestAnimationFrame(retry);
		};
		frame = requestAnimationFrame(retry);
		return () => {
			disposed = true;
			if (frame !== 0) cancelAnimationFrame(frame);
			// A StrictMode cleanup before attachment has no snapshot to save.
			teardown?.();
		};
	}, [interactionRootRef, layout, scrollRef, scrollToBottom, sessionKey, state]);

	return null;
}

export function TranscriptContent({
	children,
	historyHidden = false,
}: {
	children: ReactNode;
	historyHidden?: boolean;
}) {
	const { scrollRef, stopScroll } = useStickToBottomContext();
	const handleWheelCapture = useCallback(
		(event: ReactWheelEvent<HTMLDivElement>) => {
			if (historyHidden) return;
			const element = scrollRef.current;
			if (
				element &&
				shouldEscapeTranscriptBottomLock({
					deltaY: event.deltaY,
					scrollHeight: element.scrollHeight,
					clientHeight: element.clientHeight,
				})
			) {
				stopScroll();
			}
		},
		[historyHidden, scrollRef, stopScroll],
	);

	return (
		<StickToBottom.Content
			// Capture before inner overflow-x containers. use-stick-to-bottom otherwise
			// mistakes those code/table/formula surfaces for vertical scroll owners.
			onWheelCapture={handleWheelCapture}
			scrollClassName="chat-timeline-scroll overflow-x-hidden"
			className="flex min-h-full w-full flex-col break-words px-(--conversation-gutter) pt-8"
		>
			{children}
		</StickToBottom.Content>
	);
}

/** Message image thumbnails; both the user bubble and custom blocks render this exact grid. */
function MessageImageGrid({
	images,
	onPreview,
	className,
}: {
	images: readonly { src: string }[];
	onPreview: (image: PreviewImage) => void;
	className?: string;
}) {
	const { t } = useTranslation();
	if (images.length === 0) return null;
	return (
		<div className={cn("flex flex-wrap gap-1.5", className)}>
			{images.map((image, imageIndex) => (
				<button
					// eslint-disable-next-line react/no-array-index-key -- images never reorder within a message
					key={imageIndex}
					type="button"
					className="size-24 overflow-hidden rounded-control border border-border-subtle"
					onClick={() => onPreview({ src: image.src })}
					aria-label={t("session.imagePreview")}
				>
					<img src={image.src} alt="" className="size-full object-cover" />
				</button>
			))}
		</div>
	);
}

function UserMessageBody({ text }: { text: string }) {
	const { t } = useTranslation();
	const segments = useMemo(() => parseReviewCommentSegments(text), [text]);
	if (segments.length === 1 && segments[0]?.kind === "text") {
		return <Markdown text={text} smooth={false} />;
	}
	return (
		<div className="flex flex-col gap-2">
			{segments.map((segment, index) =>
				segment.kind === "text" ? (
					segment.text.trim().length > 0 && (
						// eslint-disable-next-line react/no-array-index-key -- segments never reorder within a message
						<Markdown key={index} text={segment.text} smooth={false} />
					)
				) : (
					// eslint-disable-next-line react/no-array-index-key -- segments never reorder within a message
					<div key={index} className="rounded-control border border-border-subtle bg-surface-hover px-3 py-2 text-sm">
						<p className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-text-muted">
							<MessageSquareText className="size-3.5 shrink-0" aria-hidden="true" />
							<span className="min-w-0 truncate">{segment.filePath}</span>
							<span className="shrink-0">{segment.rangeLabel}</span>
						</p>
						{segment.text.length > 0 && <p className="mt-1 whitespace-pre-wrap leading-6">{segment.text}</p>}
						{segment.excerpt.length > 0 && (
							<details className="mt-1">
								<summary className="cursor-default select-none text-xs text-text-muted">
									{t("session.reviewCommentExcerpt")}
								</summary>
								<pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text-muted">
									{segment.excerpt}
								</pre>
							</details>
						)}
					</div>
				),
			)}
		</div>
	);
}

function CollapsibleUserMessageBody({ text }: { text: string }) {
	const { t } = useTranslation();
	const { scrollRef, stopScroll } = useStickToBottomContext();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const pendingAnchorTopRef = useRef<number | null>(null);
	const [expanded, setExpanded] = useState(false);
	const collapsible = shouldCollapseUserMessage(text);
	const collapsed = collapsible && !expanded;
	// Four thousand characters comfortably cover the collapsed viewport while bounding Markdown parsing.
	const visibleText = collapsed ? text.slice(0, 4_000) : text;

	useLayoutEffect(() => {
		const previousTop = pendingAnchorTopRef.current;
		if (previousTop === null) return;
		pendingAnchorTopRef.current = null;
		const root = rootRef.current;
		const scroller = scrollRef.current;
		if (!root || !scroller) return;
		void expanded;
		preserveViewportAnchorTop(scroller, root, previousTop);
		const frame = requestAnimationFrame(() => {
			const liveRoot = rootRef.current;
			const liveScroller = scrollRef.current;
			if (!liveRoot || !liveScroller) return;
			preserveViewportAnchorTop(liveScroller, liveRoot, previousTop);
		});
		return () => cancelAnimationFrame(frame);
	}, [expanded, scrollRef]);

	const toggleExpanded = () => {
		const root = rootRef.current;
		const scroller = scrollRef.current;
		stopScroll();
		if (root && scroller) pendingAnchorTopRef.current = root.getBoundingClientRect().top;
		setExpanded((value) => !value);
	};

	return (
		<div ref={rootRef}>
			<div
				className={cn("relative", collapsed && "max-h-44 overflow-hidden")}
				style={
					collapsed
						? {
								WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)",
								maskImage: "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)",
							}
						: undefined
				}
			>
				<UserMessageBody text={visibleText} />
			</div>
			{collapsible && (
				<button
					type="button"
					aria-expanded={expanded}
					onClick={toggleExpanded}
					className="-ml-1 mt-1.5 min-h-6 rounded-control px-1.5 py-0.5 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
				>
					{t(expanded ? "session.collapseMessage" : "session.showFullMessage")}
				</button>
			)}
		</div>
	);
}

export function UserMessageBubble({
	text,
	images,
	onEdit,
	editDraft,
	onBeginEdit,
	onEditDraftChange,
	onCancelEdit,
	disabled,
}: {
	text: string;
	images: MessageImage[];
	onEdit?: ((newText: string) => void) | undefined;
	editDraft: string | null;
	onBeginEdit: () => void;
	onEditDraftChange: (draft: string) => void;
	onCancelEdit: () => void;
	disabled: boolean;
}) {
	const { t } = useTranslation();
	const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
	const projectCwd = useContext(MarkdownImageRootContext);
	const {
		limitExceeded: editLimitExceeded,
		resetLimitExceeded: resetEditLimitExceeded,
		reportLimitExceeded: reportEditLimitExceeded,
		setBoundedValue: setEditDraft,
	} = useBoundedTextInput(onEditDraftChange, SESSION_MESSAGE_TEXT_MAX_CHARS);

	if (editDraft !== null) {
		return (
			<div className="scene-surface ml-auto flex w-full max-w-xl flex-col gap-3 rounded-panel border border-border-strong bg-user-bubble px-4 py-3 text-base leading-6">
				<ComposerInput
					draft={{ ...EMPTY_DRAFT, text: editDraft }}
					projectCwd={projectCwd}
					ariaInvalid={editLimitExceeded}
					onChange={(draft) => setEditDraft(draft.text)}
					onLimit={reportEditLimitExceeded}
					contextEnabled={false}
					autofocus
					onKeyDown={() => undefined}
					onPaste={() => undefined}
					onSelectionChange={() => undefined}
					onOpenContext={() => undefined}
				/>
				{editLimitExceeded && (
					<FeedbackNotice tone="danger" className="text-xs">
						{t("session.messageTextLimit", { count: SESSION_MESSAGE_TEXT_MAX_CHARS })}
					</FeedbackNotice>
				)}
				<div className="flex justify-end gap-1.5">
					<Button size="sm" type="button" onClick={onCancelEdit} variant="ghost">
						{t("session.cancel")}
					</Button>
					<Button
						size="sm"
						type="button"
						disabled={submitMessageText(editDraft) === null}
						onClick={() => {
							const submitted = submitMessageText(editDraft);
							if (submitted === null) return;
							onEdit?.(submitted);
						}}
					>
						{t("session.editSubmit")}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="group ml-auto flex max-w-xl flex-col items-end gap-1">
			<ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />
			<div className="scene-surface flex min-w-0 max-w-full flex-col gap-1.5 rounded-panel bg-user-bubble px-4 py-3 text-base leading-6">
				<MessageImageGrid images={images} onPreview={setPreviewImage} />
				<CollapsibleUserMessageBody text={text} />
			</div>
			{onEdit && (
				<button
					type="button"
					onClick={() => {
						resetEditLimitExceeded();
						onBeginEdit();
					}}
					disabled={disabled}
					className="flex min-h-6 items-center gap-1 rounded-control px-1.5 py-0.5 text-xs text-text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-text-primary focus:opacity-100 disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
				>
					<Pencil className="size-3" aria-hidden="true" />
					{t("session.edit")}
				</button>
			)}
		</div>
	);
}

export function CustomMessageBlock({
	message,
	toolsExpanded,
}: {
	message: Extract<SessionMessage, { role: "custom" }>;
	toolsExpanded: boolean;
}) {
	const { t } = useTranslation();
	const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
	const [fallbackExpanded, setFallbackExpanded] = useState(false);
	const images = useMessageImages(message.content);
	if (!message.display) return null;

	const text = partsText(message.content);
	const rendered = message.rendered;
	const renderedLineSelection = selectCustomMessageRenderedLines(rendered, toolsExpanded);
	const renderFailed = rendered?.error !== undefined;
	// No extension renderer: the content is what the extension wrote for the model, so keep
	// it to one summary line (like Pi's default custom-message box) until the user expands.
	const fallbackBody = !renderedLineSelection && !renderFailed && text.length > 0;
	const fallbackSummary = fallbackBody ? customMessageSummary(text) : null;
	const showFallbackBody = fallbackBody && (fallbackExpanded || fallbackSummary === null);
	return (
		<div className="skin-surface w-full rounded-panel border border-border-subtle bg-reading-surface px-3.5 py-3">
			<ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />
			<div className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
				<span className="shrink-0 rounded-control border border-border-subtle bg-surface px-1.5 py-0.5 font-mono">
					{message.customType}
				</span>
				{fallbackSummary !== null && (
					<button
						type="button"
						onClick={() => setFallbackExpanded((current) => !current)}
						aria-expanded={fallbackExpanded}
						aria-label={fallbackExpanded ? t("session.customMessageCollapse") : t("session.customMessageExpand")}
						className="flex min-w-0 flex-1 items-center gap-1 rounded-control px-1 py-0.5 text-left transition-colors hover:text-text-primary"
					>
						<span className="min-w-0 flex-1 truncate">{fallbackSummary}</span>
						<ChevronRight
							className={cn(
								"size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
								fallbackExpanded && "rotate-90",
							)}
							aria-hidden="true"
						/>
					</button>
				)}
			</div>
			{rendered?.error && (
				<FeedbackNotice tone="danger" className="mb-2 text-xs">
					<span className="min-w-0 whitespace-pre-wrap break-words">{rendered.error}</span>
				</FeedbackNotice>
			)}
			{renderedLineSelection && <RenderedTerminalLines lines={renderedLineSelection.lines} />}
			{!renderFailed && <MessageImageGrid images={images} onPreview={setPreviewImage} className="mb-2" />}
			{showFallbackBody && (
				<div className={cn("mt-2", EXPANDED_DETAIL_SCROLL_CLASS)}>
					<Markdown text={text} />
				</div>
			)}
		</div>
	);
}

/** First human-readable line of model-facing custom content: markup-only lines (e.g. an
 * XML event envelope) are skipped so the collapsed row shows the sentence, not the tag. */
function customMessageSummary(text: string): string | null {
	for (const rawLine of text.split("\n")) {
		const line = rawLine
			.replace(/<[^>]*>/g, "")
			.replace(/^[\s>*\-#]+/, "")
			.trim();
		if (line.length > 0) return line;
	}
	return null;
}
