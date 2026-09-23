import type { TFunction } from "i18next";
import { sessionKey } from "@ling/contracts/session-ref";
import { Markdown } from "@renderer/components/markdown";
import { StatusGlyph } from "@renderer/components/ui/status-glyph";
import { sessionToolExecutionsFamily } from "@renderer/features/sessions/state/session";
import { useStreamingText } from "@renderer/hooks/use-streaming-text";
import { tildify } from "@renderer/lib/format-path";
import { cn } from "@renderer/lib/utils";
import Ansi from "ansi-to-react";
import { atom, useAtomValue } from "jotai";
import {
	Brain,
	ChevronDown,
	CircleAlert,
	FileText,
	GitCompareArrows,
	LoaderCircle,
	Pencil,
	Terminal,
	Wrench,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { projectExtensionTerminalText } from "../extension-ui/extension-terminal-text";
import { activityPreviewText, activityStreamingPreviewText } from "./activity-preview-text";
import { activitySummary } from "./activity-summary";
import { AssistantMessageDetails } from "./assistant-message";
import {
	AssistantContent,
	AssistantMarkdownPart,
	EXPANDED_DETAIL_SCROLL_CLASS,
	RenderedTerminalLines,
} from "./assistant-render";
import { selectCustomMessageRenderedLines } from "./custom-message-lines";
import { useSessionImageRef } from "./session-image-source";
import { toolCallSummary } from "./tool-call-label";
import { ToolProgressBlock } from "./tool-progress";
import { ToolResultBlock } from "./tool-result";
import {
	type ActivityFailureItem,
	type ActivityRow,
	type ToolCategory,
	type ToolStep,
	activityHasWork,
	toolCategoryForName,
} from "./transcript-activity-model";
import { CompactionDivider, CustomMessageBlock } from "./transcript-rows";
import { useThrottledVisualUpdate } from "./use-throttled-visual-update";
import { WorkingIndicator } from "./working-indicator";

/** Settled extension messages never change; only `toolsExpanded` can re-render them. */
const ActivityCustomMessage = memo(CustomMessageBlock);

/** The four activity icons; one per category, used by the activity row's collapsed header. */
const TOOL_CATEGORY_ICON: Record<ToolCategory, typeof FileText> = {
	read: FileText,
	edit: Pencil,
	run: Terminal,
	other: Wrench,
};

interface ToolStepPresentation {
	detail: string | null;
	cardHeader: string | undefined;
}

function toolStepPresentation(call: ToolStep["call"]): ToolStepPresentation {
	const summary = toolCallSummary({ name: call.name, arguments: call.arguments ?? {} });
	const tildified = (text: string) => (summary.isPath ? tildify(text) : text);
	return {
		detail: summary.detail === null ? null : tildified(summary.detail),
		cardHeader: summary.fullDetail === null ? undefined : tildified(summary.fullDetail),
	};
}

/**
 * Set of tool names that write to disk (including aliases). Used to decide whether a step
 * result shows write-path UI like "open in review"; aligned with TOOL_CATEGORY's edit class
 * and covering historical SDK aliases.
 */
const EDIT_TOOL_NAMES = new Set(["write", "edit", "write_file", "edit_file"]);

/**
 * Item components below are memoized on their data props only. Their callbacks are inline
 * closures over per-row stable identities (`onDisclosureChange`, `rowId`, a call id), so a
 * fresh function identity per parent render carries no new information — and a running
 * activity row re-renders on every stream tick with hundreds of settled items inside it.
 */
const ToolStepView = memo(
	function ToolStepView({
		step,
		interrupted,
		toolsExpanded,
		manualExpanded,
		onExpandedChange,
		onOpenFileReview,
	}: {
		step: ToolStep;
		/** The run ended without this call's result — crash, abort, or kill mid-turn. */
		interrupted: boolean;
		toolsExpanded: boolean;
		manualExpanded: boolean | undefined;
		onExpandedChange: (expanded: boolean) => void;
		/** Set on file-editing tools: opens the change review focused on that file. */
		onOpenFileReview?: ((path: string) => void) | undefined;
	}) {
		const ref = useSessionImageRef();
		const key = ref === null ? "" : sessionKey(ref);
		const progressAtom = useMemo(
			() => atom((get) => get(sessionToolExecutionsFamily(key)).find((item) => item.toolCallId === step.call.id)),
			[key, step.call.id],
		);
		const progress = useAtomValue(progressAtom);
		const { t } = useTranslation();
		const {
			Icon,
			expandedCall,
			hasDetails,
			expanded,
			failed,
			detail,
			cardHeader,
			renderedSummary,
			reviewPath,
			statusLabel,
		} = projectToolStepState(
			step,
			progress !== undefined,
			toolsExpanded,
			manualExpanded,
			interrupted,
			onOpenFileReview !== undefined,
			t,
		);
		return (
			<div
				className={cn(
					"flex flex-col rounded-control px-0.5 py-0.5 transition-colors",
					hasDetails && "hover:bg-surface-hover/70",
				)}
			>
				<div className="group/toolstep flex min-w-0 items-center gap-1.5">
					<button
						type="button"
						disabled={!hasDetails}
						onClick={() => onExpandedChange(!expanded)}
						aria-expanded={hasDetails ? expanded : undefined}
						className={cn(
							"flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-xs focus-visible:bg-surface-hover/70",
							failed ? "text-danger" : "text-text-muted",
						)}
					>
						<span className="flex size-5 shrink-0 items-center justify-center" title={statusLabel}>
							<StatusGlyph status={failed || interrupted ? "error" : step.result ? "success" : "active"} />
							<span className="sr-only">{statusLabel}</span>
						</span>{" "}
						<span className="flex size-5 shrink-0 items-center justify-center">
							<Icon className="size-3.5 opacity-80" aria-hidden="true" />
						</span>
						<span className={cn("shrink-0 font-medium", failed ? "text-danger" : "text-text-primary/85")}>
							{step.call.name}
						</span>
						{!expanded && renderedSummary ? (
							<span className="min-w-0 truncate">
								<Ansi useClasses>{projectExtensionTerminalText(renderedSummary)}</Ansi>
							</span>
						) : (
							detail && !expanded && <span className="min-w-0 truncate">{detail}</span>
						)}
						{hasDetails && (
							<ChevronDown
								className={cn(
									"size-3.5 shrink-0 text-text-muted transition-transform motion-reduce:transition-none",
									!expanded && "-rotate-90",
								)}
								aria-hidden="true"
							/>
						)}
					</button>
					{reviewPath && <ReviewFileButton onClick={() => onOpenFileReview?.(reviewPath)} />}
				</div>
				{expanded && (
					<div
						className={cn(
							"mt-1 ml-7 flex min-w-0 flex-col gap-2 border-border-subtle border-l pl-3",
							EXPANDED_DETAIL_SCROLL_CLASS,
						)}
					>
						{expandedCall && <RenderedTerminalLines lines={expandedCall.lines} inline />}
						{!step.result && progress && <ToolProgressBlock progress={progress} />}
						{step.result && (
							<ToolResultBlock message={step.result} showName={false} command={cardHeader} variant="inline" />
						)}
					</div>
				)}
			</div>
		);
	},
	(prev, next) =>
		prev.step.call === next.step.call &&
		prev.step.result === next.step.result &&
		prev.interrupted === next.interrupted &&
		prev.toolsExpanded === next.toolsExpanded &&
		prev.manualExpanded === next.manualExpanded,
);

/** The file path an editing tool targeted, for the jump-to-review affordance. */
function editToolPath(call: ToolStep["call"]): string | null {
	const path = call.arguments?.path;
	return typeof path === "string" && path.length > 0 ? path : null;
}

function ReviewFileButton({ onClick }: { onClick: () => void }) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={t("session.reviewFile")}
			title={t("session.reviewFile")}
			// Always reserve width — toggling display:none→flex on hover shoves the row (jitter).
			className="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-text-primary group-hover/toolstep:opacity-100 group-focus-within/toolstep:opacity-100 focus-visible:opacity-100"
		>
			<GitCompareArrows className="size-3.5" aria-hidden="true" />
		</button>
	);
}

function useDurationLabel(seconds: number | undefined): string | undefined {
	const { t } = useTranslation();
	if (seconds === undefined) return undefined;
	if (seconds < 60) return t("session.durationSec", { s: seconds });
	return t("session.durationMin", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

/** Running status delegates its clock to the indicator; settled duration stays static. */
function ActivityHeader({
	running,
	startTs,
	endTs,
	summary,
	expanded,
	onToggle,
}: {
	running: boolean;
	summary: string;
	startTs: number | undefined;
	endTs: number | undefined;
	expanded: boolean;
	onToggle: () => void;
}) {
	const { t } = useTranslation();
	const seconds =
		startTs !== undefined && endTs !== undefined ? Math.max(0, Math.round((endTs - startTs) / 1000)) : undefined;
	const duration = useDurationLabel(seconds);
	const label = duration ? t("session.workedFor", { duration }) : t("session.activity");
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			className="flex min-h-6 w-fit items-center gap-1 rounded-control px-1 py-0.5 text-xs tabular-nums text-text-muted transition-colors hover:text-text-primary"
		>
			{running ? (
				<WorkingIndicator startedAt={startTs} />
			) : (
				<span className="min-w-0">
					{summary}
					{summary && " · "}
					{label}
				</span>
			)}
			<ChevronDown
				className={cn(
					"size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
					!expanded && "-rotate-90",
				)}
				aria-hidden="true"
			/>
		</button>
	);
}

export function ActivityGroup({
	row,
	busy,
	toolsExpanded = false,
	hiddenThinkingLabel,
	disclosures,
	onDisclosureChange,
	onOpenFileReview,
	onFork,
}: {
	row: ActivityRow;
	busy: boolean;
	toolsExpanded?: boolean;
	hiddenThinkingLabel?: string | null | undefined;
	disclosures: ReadonlyMap<string, boolean> | undefined;
	onDisclosureChange: (key: string, expanded: boolean) => void;
	onOpenFileReview?: ((path: string) => void) | undefined;
	onFork(entryId: string): void;
}) {
	const expanded =
		row.turnFoldState === "expanded" ||
		(row.turnFoldState === null && (disclosures?.get("activity") ?? row.turnActive));
	const workItems = row.items;
	const { t } = useTranslation();
	const counts = { read: 0, edit: 0, run: 0, other: 0 };
	for (const item of workItems) if (item.type === "step") counts[toolCategoryForName(item.step.call.name)] += 1;

	return (
		<div className="group flex min-w-0 flex-col gap-2">
			{row.turnFoldState === null && (row.turnActive || activityHasWork(row)) && (
				<ActivityHeader
					summary={activitySummary(counts, t)}
					running={row.turnActive}
					startTs={row.startTs}
					endTs={row.endTs}
					expanded={expanded}
					onToggle={() => onDisclosureChange("activity", !expanded)}
				/>
			)}
			{workItems.length > 0 && (
				<div className="-mx-1 flex flex-col gap-px">
					{workItems.map((item, index) => {
						const terminalText = item.type === "text" && item.messageId === row.terminalReply?.messageId;
						if (!expanded && !terminalText) return null;
						const streamingTail = row.running && index === workItems.length - 1;
						if (item.type === "thinking") {
							return (
								<ReasoningBlock
									// eslint-disable-next-line react/no-array-index-key -- items never reorder within a turn
									key={index}
									text={item.text}
									isStreaming={streamingTail}
									hiddenThinkingLabel={hiddenThinkingLabel}
									manualExpanded={disclosures?.get(`reasoning:${index}`)}
									onExpandedChange={(nextExpanded) => onDisclosureChange(`reasoning:${index}`, nextExpanded)}
								/>
							);
						}
						if (item.type === "failure") {
							return (
								<FailedAttemptLine
									// eslint-disable-next-line react/no-array-index-key -- items never reorder within a turn
									key={index}
									failure={item}
									streaming={streamingTail}
								/>
							);
						}
						if (item.type === "custom") {
							return (
								// eslint-disable-next-line react/no-array-index-key -- items never reorder within a turn
								<div key={index} className="min-w-0 px-1 py-1">
									<ActivityCustomMessage message={item.message} toolsExpanded={toolsExpanded} />
								</div>
							);
						}
						if (item.type === "compaction") {
							return (
								// eslint-disable-next-line react/no-array-index-key -- items never reorder within a turn
								<div key={index} className="min-w-0 px-1 py-1">
									<CompactionDivider summary={item.summary} />
								</div>
							);
						}
						if (item.type === "text") {
							return (
								// eslint-disable-next-line react/no-array-index-key -- items never reorder within a turn
								<div key={index} className="min-w-0 px-1 py-1">
									<AssistantMarkdownPart text={item.text} streaming={streamingTail} />
								</div>
							);
						}
						return (
							<ToolStepView
								key={item.step.call.id}
								step={item.step}
								interrupted={!row.turnActive && !item.step.result}
								toolsExpanded={toolsExpanded}
								manualExpanded={disclosures?.get(`tool:${item.step.call.id}`)}
								onExpandedChange={(nextExpanded) => onDisclosureChange(`tool:${item.step.call.id}`, nextExpanded)}
								onOpenFileReview={onOpenFileReview}
							/>
						);
					})}
				</div>
			)}
			{row.terminalReply && (
				<AssistantMessageDetails
					message={row.terminalReply.message}
					streaming={false}
					busy={busy}
					showError={false}
					onFork={onFork}
				/>
			)}
		</div>
	);
}

/** One failed attempt of the turn, as Pi's TUI shows it: the partial reply (if any) and a
 * single muted error line. The live retry itself is reported by the working-status row and
 * a turn that ends failed is flagged by its fold header, so no danger block is needed here. */
function FailedAttemptLine({ failure, streaming }: { failure: ActivityFailureItem; streaming: boolean }) {
	const { t } = useTranslation();
	const hasText = failure.message.content.some((part) => part.type === "text" && part.text.trim().length > 0);
	const error = failure.message.errorMessage ?? t("session.turnError");
	return (
		<div className="min-w-0 px-1 py-0.5">
			{hasText && <AssistantContent content={failure.message.content} streaming={streaming} />}
			{!failure.resolvedByLaterCompaction && (
				<p className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted" title={error}>
					<CircleAlert className="size-3.5 shrink-0 text-danger/70" aria-hidden="true" />
					<span className="truncate">
						{failure.attempt === 1
							? t("session.failedAttempt")
							: t("session.failedRetry", { attempt: failure.attempt - 1 })}{" "}
						· {error}
					</span>
				</p>
			)}
		</div>
	);
}

const ReasoningBlock = memo(
	function ReasoningBlock({
		text,
		isStreaming,
		hiddenThinkingLabel,
		manualExpanded,
		onExpandedChange,
	}: {
		text: string;
		isStreaming: boolean;
		hiddenThinkingLabel?: string | null | undefined;
		manualExpanded: boolean | undefined;
		onExpandedChange: (expanded: boolean) => void;
	}) {
		const { t } = useTranslation();
		const output = useStreamingText(text, isStreaming);
		// Collapsed unless the reader opened it: a streaming turn stays one line per thought instead of
		// pushing the answer off-screen. An explicit open survives the end of the stream.
		const expanded = manualExpanded ?? false;
		const preview = output.streaming ? activityStreamingPreviewText(output.text) : activityPreviewText(output.text);
		const showPreview = !expanded && preview.length > 0;
		const summaryRef = useRef<HTMLSpanElement>(null);
		// The newest characters sit past the right edge once the line outgrows the row, so hold the
		// summary scrolled to its end while it grows and release it back to the start when it settles.
		const alignSummary = useThrottledVisualUpdate(() => {
			const element = summaryRef.current;
			if (element === null) return;
			element.scrollLeft = output.streaming ? element.scrollWidth - element.clientWidth : 0;
		});
		useEffect(() => {
			if (showPreview) alignSummary();
		}, [alignSummary, output.streaming, preview, showPreview]);
		return (
			<div className="flex flex-col rounded-control px-0.5 py-0.5 transition-colors hover:bg-surface-hover/70">
				<button
					type="button"
					onClick={() => onExpandedChange(!expanded)}
					aria-expanded={expanded}
					className={cn(
						"flex min-w-0 items-center gap-1.5 rounded-sm text-left text-xs transition-colors focus-visible:bg-surface-hover/70",
						isStreaming ? "text-accent" : "text-text-muted",
					)}
				>
					<span className="flex size-5 shrink-0 items-center justify-center">
						<Brain className="size-3.5 opacity-80" aria-hidden="true" />
					</span>
					<span className={cn("shrink-0 font-medium", isStreaming ? "text-accent" : "text-text-primary/85")}>
						{isStreaming ? t("session.thinking") : (hiddenThinkingLabel ?? t("session.thoughtProcess"))}
					</span>
					{showPreview && (
						<span
							ref={summaryRef}
							className={cn(
								"min-w-0 overflow-hidden whitespace-nowrap text-text-muted",
								// An ellipsis would paint over the very characters the scroll is revealing.
								isStreaming ? "text-clip" : "text-ellipsis",
							)}
						>
							{preview}
						</span>
					)}
					<ChevronDown
						className={cn(
							"size-3.5 shrink-0 text-text-muted transition-transform motion-reduce:transition-none",
							!expanded && "-rotate-90",
						)}
						aria-hidden="true"
					/>
					{isStreaming && (
						<span className="ling-spin ml-auto shrink-0" aria-hidden="true">
							<LoaderCircle className="size-3.5" />
						</span>
					)}
				</button>
				{expanded && (
					<div className={cn("mt-1 ml-7 border-border-subtle border-l pl-3", EXPANDED_DETAIL_SCROLL_CLASS)}>
						<Markdown text={output.text} streaming={output.streaming} smooth={false} className="reasoning-markdown" />
					</div>
				)}
			</div>
		);
	},
	(prev, next) =>
		prev.text === next.text &&
		prev.isStreaming === next.isStreaming &&
		prev.hiddenThinkingLabel === next.hiddenThinkingLabel &&
		prev.manualExpanded === next.manualExpanded,
);

/** Pure presentation keeps live progress subscription separate from tool formatting. */
function projectToolStepState(
	step: ToolStep,
	progress: boolean,
	toolsExpanded: boolean,
	manualExpanded: boolean | undefined,
	interrupted: boolean,
	canReview: boolean,
	t: TFunction,
) {
	const Icon = TOOL_CATEGORY_ICON[toolCategoryForName(step.call.name)];
	const collapsedCall = step.call.rendered?.error ? null : selectCustomMessageRenderedLines(step.call.rendered, false);
	const expandedCall = step.call.rendered?.error ? null : selectCustomMessageRenderedLines(step.call.rendered, true);
	const hasDetails = Boolean(step.result || progress || (expandedCall && expandedCall.lines.length > 0));
	const expanded = hasDetails && (manualExpanded ?? toolsExpanded);
	const failed = step.result?.isError === true;
	const { detail, cardHeader } = toolStepPresentation(step.call);
	const renderedSummary = collapsedCall?.lines.find((line) => line.trim().length > 0);
	const reviewPath = canReview && EDIT_TOOL_NAMES.has(step.call.name) ? editToolPath(step.call) : null;
	const statusLabel = failed
		? t("session.toolFailed")
		: interrupted
			? t("session.toolInterrupted")
			: step.result
				? t("session.toolCompleted")
				: t("session.toolRunning");
	return {
		Icon,
		expandedCall,
		hasDetails,
		expanded,
		failed,
		detail,
		cardHeader,
		renderedSummary,
		reviewPath,
		statusLabel,
	};
}
