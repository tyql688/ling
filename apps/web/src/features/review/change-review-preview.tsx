import type { DiffScrollPosition } from "./diff-scroll-position";
import type { ChangeReviewFile } from "@ling/contracts/git";
import type { ReviewCommentDraft, ReviewCommentIssue } from "@ling/contracts/draft-review-comments";
import { reviewMediaUrl } from "@ling/contracts/markdown-image-url";
import { type PreviewMediaKind, previewMediaKind } from "@ling/contracts/preview-media";
import { WORKSPACE_SUBHEADER_CLASS } from "@renderer/components/shell-chrome";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { DiffView } from "@renderer/features/review/diff-view";
import { cn } from "@renderer/lib/utils";
import { ArrowLeft, Columns2, FileText, FoldVertical, Rows2, UnfoldVertical } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changedFileLabel } from "./changed-file-label";
import type { PreviewState } from "./use-change-review-diff-preview";

const FileDiffReview = lazy(() =>
	import("./file-diff-review").then(({ FileDiffReview }) => ({ default: FileDiffReview })),
);

/** Wide review panes default to two columns; narrower panes retain readable single-column code. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 840;

/** A picture is drawn; a clip gets controls rather than autoplay, since two looping videos side by
 * side fight for attention in a pane meant for reading a change. */
function MediaFigure({
	label,
	src,
	kind,
	onError,
}: {
	label: string;
	src: string;
	kind: PreviewMediaKind;
	onError?: () => void;
}) {
	const frameClass =
		"max-h-[26rem] w-full rounded-control border border-border-subtle bg-surface-raised object-contain";
	return (
		<figure className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
			<figcaption className="text-xs uppercase tracking-wide text-text-muted">{label}</figcaption>
			{kind === "video" ? (
				// A clip under review is a file's content, not authored media, so it has no caption track.
				// eslint-disable-next-line jsx-a11y/media-has-caption
				<video src={src} controls playsInline className={frameClass} {...(onError ? { onError } : {})} />
			) : (
				<img src={src} alt="" className={frameClass} {...(onError ? { onError } : {})} />
			)}
		</figure>
	);
}

/**
 * A changed picture or clip, rather than the patch text for one. The baseline comes out of the last
 * commit and the current version off disk; either side can be absent — an added file has no
 * baseline, a deleted one has no working copy — and a turn-scoped review has no baseline at all,
 * because only the patch survives a turn, not the bytes it replaced.
 */
function ChangeReviewMediaPane({
	cwd,
	file,
	baseAvailable,
	revisions,
}: {
	cwd: string;
	file: ChangeReviewFile;
	baseAvailable: boolean;
	revisions?: { base: string; current: string } | undefined;
}) {
	const { t } = useTranslation();
	const [failed, setFailed] = useState<{ base: boolean; current: boolean }>({ base: false, current: false });
	const kind = previewMediaKind(file.path) ?? "image";
	const showBase =
		baseAvailable && file.status !== "added" && file.status !== "untracked" && file.status !== "clean" && !failed.base;
	const showCurrent = file.status !== "deleted" && !failed.current;
	return (
		<div className="flex h-full min-h-0 flex-wrap items-start gap-3">
			{showBase && (
				<MediaFigure
					label={t("changes.imageBefore")}
					src={reviewMediaUrl(cwd, file.from ?? file.path, "base", revisions?.base)}
					kind={kind}
					onError={() => setFailed((current) => ({ ...current, base: true }))}
				/>
			)}
			{showCurrent && (
				<MediaFigure
					label={t("changes.imageAfter")}
					src={reviewMediaUrl(cwd, file.path, "current", revisions?.current)}
					kind={kind}
					onError={() => setFailed((previous) => ({ ...previous, current: true }))}
				/>
			)}
			{!showBase && !showCurrent && <p className="text-xs text-text-muted">{t("changes.imageUnavailable")}</p>}
		</div>
	);
}

export function ChangeReviewDetailPane({
	scrollPosition,
	cwd,
	selectedFile,
	displayPath,
	visiblePreview,
	previewError,
	loadingPreview,
	canExpandDiffContext,
	imageBaseAvailable,
	imageRevisions,
	onExpandContext,
	onAddComment,
	onBack,
	backLabel,
	alwaysShowBack,
	headerActions,
	seamless = false,
}: ChangeReviewDetailProps) {
	const { t } = useTranslation();
	const detailRef = useRef<HTMLDivElement>(null);
	const [wide, setWide] = useState(false);
	const [diffStyleOverride, setDiffStyleOverride] = useState<"unified" | "split" | null>(null);
	const [expandUnchanged, setExpandUnchanged] = useState(false);
	const { onEditorReady, pending, seamlessDiff, headerPath } = useReviewPreviewPaint({
		visiblePreview,
		selectedFile,
		loadingPreview,
		seamless,
		displayPath,
	});
	useEffect(() => {
		const detail = detailRef.current;
		if (detail === null) return;
		const resize = new ResizeObserver(([entry]) => {
			// Hidden workspace views may be measured at zero; their last geometry remains authoritative.
			if (entry !== undefined && entry.contentRect.width > 0)
				setWide(entry.contentRect.width >= SIDE_BY_SIDE_MIN_WIDTH_PX);
		});
		resize.observe(detail);
		return () => resize.disconnect();
	}, []);
	const diffStyle = diffStyleOverride ?? (wide ? "split" : "unified");
	const diffVisible = visiblePreview?.kind === "diff";
	const fullDiffAvailable = diffVisible && visiblePreview.editor?.status === "available";
	const canToggleUnchanged = diffVisible && (fullDiffAvailable || canExpandDiffContext);
	const unchangedExpanded = fullDiffAvailable && expandUnchanged;
	return (
		<div
			ref={detailRef}
			className="glass-surface change-review-detail flex min-h-0 min-w-0 flex-1 flex-col bg-workbench-surface"
		>
			<div className={cn(WORKSPACE_SUBHEADER_CLASS, "gap-1.5 text-xs text-text-muted")}>
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						aria-label={backLabel ?? t("changes.backToFiles")}
						className={cn(
							alwaysShowBack ? "inline-flex" : "change-review-back",
							"-ml-1 size-7 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary",
						)}
					>
						<ArrowLeft className="size-4" aria-hidden="true" />
					</button>
				)}
				<FileText className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate" title={headerPath}>
					{headerPath ?? t("changes.noSelection")}
				</span>
				<div className="ml-auto flex shrink-0 items-center gap-0.5" inert={pending}>
					{headerActions}
					{diffVisible && (
						<TooltipIconButton
							label={t(diffStyle === "split" ? "changes.diffUseUnified" : "changes.diffUseSplit")}
							aria-pressed={diffStyle === "split"}
							onClick={() => setDiffStyleOverride(diffStyle === "split" ? "unified" : "split")}
						>
							{diffStyle === "split" ? (
								<Rows2 className="size-4" aria-hidden="true" />
							) : (
								<Columns2 className="size-4" aria-hidden="true" />
							)}
						</TooltipIconButton>
					)}
					{canToggleUnchanged && (
						<TooltipIconButton
							label={t(
								fullDiffAvailable
									? unchangedExpanded
										? "changes.diffCollapseUnchanged"
										: "changes.diffExpandUnchanged"
									: "changes.diffExpandContext",
							)}
							aria-pressed={unchangedExpanded}
							disabled={loadingPreview}
							onClick={() => {
								if (fullDiffAvailable) setExpandUnchanged((current) => !current);
								else onExpandContext();
							}}
						>
							{unchangedExpanded ? (
								<FoldVertical className="size-4" aria-hidden="true" />
							) : (
								<UnfoldVertical className="size-4" aria-hidden="true" />
							)}
						</TooltipIconButton>
					)}
				</div>
				{pending && visiblePreview !== null && (
					<span role="status" className="sr-only">
						{t("changes.loading")}
					</span>
				)}
			</div>
			<div
				className={cn("min-h-0 flex-1 overflow-auto", seamlessDiff ? "p-0" : "p-3")}
				inert={pending && visiblePreview !== null}
				aria-busy={pending}
			>
				{loadingPreview && visiblePreview === null ? (
					<LoadingTransition label={t("changes.loading")} className="h-full min-h-40" />
				) : previewError && visiblePreview === null ? (
					<FeedbackNotice tone="danger" className="text-xs">
						<p className="whitespace-pre-wrap">{previewError}</p>
					</FeedbackNotice>
				) : visiblePreview?.kind === "diff" ? (
					<ReviewDiffPreview
						preview={visiblePreview}
						scrollPosition={scrollPosition}
						onEditorReady={onEditorReady}
						selectedFile={selectedFile}
						previewError={previewError}
						seamless={seamless}
						onAddComment={onAddComment}
						diffStyle={diffStyle}
						expandUnchanged={expandUnchanged}
						onLoadContext={canExpandDiffContext ? onExpandContext : undefined}
					/>
				) : visiblePreview?.kind === "media" && selectedFile ? (
					<ChangeReviewMediaPane
						key={[
							selectedFile.path,
							imageRevisions?.base ?? "workspace-base",
							imageRevisions?.current ?? "workspace-current",
							imageBaseAvailable ? "with-base" : "without-base",
						].join("\u0000")}
						cwd={cwd}
						file={selectedFile}
						baseAvailable={imageBaseAvailable}
						revisions={imageRevisions}
					/>
				) : visiblePreview?.kind === "empty" ? (
					<p className="text-xs text-text-muted">{t("changes.noDiff")}</p>
				) : (
					<p className="text-xs text-text-muted">{t("changes.noSelection")}</p>
				)}
			</div>
		</div>
	);
}

type ChangeReviewDetailProps = {
	scrollPosition?: DiffScrollPosition | undefined;
	cwd: string;
	selectedFile: ChangeReviewFile | null;
	/** Header identity retained while the authoritative file record is loading or has disappeared. */
	displayPath?: string | undefined;
	visiblePreview: PreviewState;
	previewError: string | null;
	loadingPreview: boolean;
	canExpandDiffContext: boolean;
	/** False for a turn-scoped review, where the replaced bytes no longer exist anywhere. */
	imageBaseAvailable: boolean;
	/** Immutable commit sides used by unpushed review instead of HEAD plus the working tree. */
	imageRevisions?: { base: string; current: string } | undefined;
	onExpandContext: () => void;
	onAddComment: (comment: Omit<ReviewCommentDraft, "id">) => ReviewCommentIssue | null;
	onBack?: () => void;
	/** Compact review navigation can return to its file list. */
	backLabel?: string | undefined;
	alwaysShowBack?: boolean | undefined;
	headerActions?: ReactNode;
	/** Main-tab detail fills the continuous workbench instead of nesting another card. */
	seamless?: boolean;
};

function useReviewPreviewPaint({
	visiblePreview,
	selectedFile,
	loadingPreview,
	seamless,
	displayPath,
}: Pick<ChangeReviewDetailProps, "visiblePreview" | "selectedFile" | "loadingPreview" | "seamless" | "displayPath">) {
	const [paintedPreview, setPaintedPreview] = useState<PreviewState>(null);
	const editorPreview =
		visiblePreview?.kind === "diff" && visiblePreview.editor?.status === "available" && selectedFile
			? visiblePreview
			: null;
	const onEditorReady = useCallback(() => setPaintedPreview(editorPreview), [editorPreview]);
	const preparingEditor = editorPreview !== null && paintedPreview !== editorPreview;
	const pending = loadingPreview || preparingEditor;
	const seamlessDiff = seamless && visiblePreview?.kind === "diff";
	const headerPreview =
		preparingEditor && paintedPreview?.owner === visiblePreview?.owner ? paintedPreview : visiblePreview;
	const retainedPath = pending ? headerPreview?.path : null;
	const headerPath = retainedPath ?? (selectedFile ? changedFileLabel(selectedFile) : displayPath);
	return { onEditorReady, pending, seamlessDiff, headerPath };
}

function ReviewDiffPreview({
	scrollPosition,
	preview,
	onEditorReady,
	selectedFile,
	previewError,
	seamless = false,
	onAddComment,
	diffStyle,
	expandUnchanged,
	onLoadContext,
}: Pick<ChangeReviewDetailProps, "scrollPosition" | "selectedFile" | "previewError" | "seamless" | "onAddComment"> & {
	preview: Extract<NonNullable<PreviewState>, { kind: "diff" }>;
	onEditorReady(): void;
	diffStyle: "unified" | "split";
	expandUnchanged: boolean;
	onLoadContext: (() => void) | undefined;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			{previewError && (
				<FeedbackNotice tone="danger" className={cn("shrink-0 text-xs", seamless && "mx-3 mt-3")}>
					<p className="whitespace-pre-wrap">{previewError}</p>
				</FeedbackNotice>
			)}
			{preview.editor?.status === "error" && (
				<FeedbackNotice tone="danger" className={cn("shrink-0 text-xs", seamless && "mx-3 mt-3")}>
					<p className="whitespace-pre-wrap">{preview.editor.message}</p>
				</FeedbackNotice>
			)}
			<div className="min-h-0 flex-1">
				{preview.editor?.status === "available" && selectedFile ? (
					<Suspense fallback={<LoadingTransition label={t("changes.loading")} className="h-full" />}>
						<FileDiffReview
							key={preview.owner}
							path={preview.path}
							original={preview.editor.original}
							modified={preview.editor.modified}
							onAddComment={onAddComment}
							onReady={onEditorReady}
							diffStyle={diffStyle}
							expandUnchanged={expandUnchanged}
							scrollPosition={scrollPosition}
							seamless={seamless}
						/>
					</Suspense>
				) : (
					<DiffView
						diff={preview.text}
						scrollPosition={scrollPosition}
						showFilename={false}
						diffStyle={diffStyle}
						onLoadContext={onLoadContext}
						fillAvailableHeight
						seamless={seamless}
						{...(selectedFile
							? {
									commentContext: {
										filePath: preview.path,
										onAddComment: onAddComment,
									},
								}
							: {})}
					/>
				)}
			</div>
		</div>
	);
}
