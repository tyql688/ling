import { resolveProjectPath } from "@renderer/lib/project-path";
import { ProjectLauncher } from "@renderer/features/projects/project-launcher";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useDomainApi } from "@renderer/lib/host-api-context";

import { Button } from "@renderer/components/ui/button";

import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";

import { LoadingTransition } from "@renderer/components/ui/loading-transition";

import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";

import { cn } from "@renderer/lib/utils";

import { AtSign, Binary, Copy, FileQuestion, FileWarning, FolderSearch, RefreshCw, TriangleAlert } from "lucide-react";

import { Suspense, useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "jotai";
import { Markdown } from "@renderer/components/markdown";
import { MarkdownImageRootContext, MarkdownDocumentContext } from "@renderer/components/markdown-image-root";
import { dirtyFileDocumentsAtom, fileDocumentKey, getRetainedFileDocument } from "./file-document-state";

import { useFilePreviewPane, type WorkspaceFilePreviewProps } from "./use-file-preview-pane";
import { formatWorkspaceFileSize } from "./workspace-explorer-format";

function PreviewState({
	icon,
	title,
	description,
	action,
}: {
	icon: typeof FileQuestion;
	title: string;
	description: string;
	action?: { label: string; onClick: () => void } | undefined;
}) {
	const Icon = icon;
	return (
		<div className="flex h-full min-h-56 items-center justify-center p-6 text-center">
			<div className="flex max-w-72 flex-col items-center">
				<div className="mb-3 grid size-11 place-items-center rounded-panel border border-border-subtle bg-surface-raised text-text-muted">
					<Icon className="size-5" strokeWidth={1.5} aria-hidden="true" />
				</div>
				<h3 className="text-sm font-medium text-text-primary">{title}</h3>
				<p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
				{action && (
					<Button type="button" variant="outline" size="sm" onClick={action.onClick} className="mt-4">
						{action.label}
					</Button>
				)}
			</div>
		</div>
	);
}
export function WorkspaceFilePreview(props: WorkspaceFilePreviewProps) {
	const {
		path,
		t,
		onInsertReference,
		onCopyPath,
		onRevealEntry,
		reload,
		loading,
		editorOwnsToolbar: sourceOwnsToolbar,
		setSelectionLineRange,
		error,
		preview,
		MonacoFileEditor,
		cwd,
		saving,
		saveError,
		save,
		imageUrl,
		locale,
		selectionLineRange,
		insertSelectionReference,
	} = useFilePreviewPane(props);

	const onError = useCommandFeedback();
	const ui = useDomainApi("ui");
	const dirtyDocuments = useAtomValue(dirtyFileDocumentsAtom);
	const markdown = path !== null && /\.(md|markdown|mdx)$/i.test(path);
	const rendered = markdown && (props.view?.mode ?? "rendered") === "rendered";
	const editorOwnsToolbar = sourceOwnsToolbar && !rendered;
	const toggleMode = () =>
		props.onViewChange?.({ mode: rendered ? "source" : "rendered", scrollTop: props.view?.scrollTop ?? 0 });
	const retained = path === null ? undefined : getRetainedFileDocument(fileDocumentKey(cwd, path));
	const content =
		path !== null && dirtyDocuments.has(fileDocumentKey(cwd, path)) && retained
			? retained.content()
			: preview?.kind === "text"
				? preview.content
				: "";
	if (path === null) {
		return (
			<div className="glass-surface workspace-explorer-detail flex min-h-0 min-w-0 flex-1 flex-col bg-workbench-surface">
				<PreviewState
					icon={FileQuestion}
					title={t("explorer.selectFileTitle")}
					description={t("explorer.selectFileDescription")}
				/>
			</div>
		);
	}
	const fileActions = (
		<div className="flex shrink-0 items-center gap-0.5">
			{ui.capabilities.nativePathOpen && <ProjectLauncher cwd={cwd} compact onError={onError} />}
			{markdown && (
				<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={toggleMode}>
					{t(rendered ? "reading.source" : "reading.preview")}
				</Button>
			)}
			<TooltipIconButton label={t("explorer.addToChat")} onClick={() => onInsertReference(path)}>
				<AtSign className="size-3.5" aria-hidden="true" />
			</TooltipIconButton>
			<TooltipIconButton label={t("explorer.copyPath")} onClick={() => onCopyPath(path)}>
				<Copy className="size-3.5" aria-hidden="true" />
			</TooltipIconButton>
			{onRevealEntry && (
				<TooltipIconButton label={t("explorer.reveal")} onClick={() => onRevealEntry(path)}>
					<FolderSearch className="size-3.5" aria-hidden="true" />
				</TooltipIconButton>
			)}
			<TooltipIconButton label={t("explorer.reloadPreview")} onClick={reload}>
				<RefreshCw
					className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")}
					aria-hidden="true"
				/>
			</TooltipIconButton>
		</div>
	);

	return (
		<div className="glass-surface workspace-explorer-detail flex min-h-0 min-w-0 flex-1 flex-col bg-workbench-surface">
			{error !== null && preview !== null && (
				<div
					role="alert"
					className="flex shrink-0 items-center gap-2 border-b border-danger/20 px-3 py-2 text-xs text-danger"
				>
					<TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1">{t("explorer.refreshFailed", { message: error })}</span>
					<Button variant="ghost" size="sm" onClick={reload}>
						{t("explorer.retry")}
					</Button>
				</div>
			)}
			{!editorOwnsToolbar && (
				<div
					className={cn(
						"flex shrink-0 items-center gap-2 border-border-subtle border-b bg-workbench-chrome px-2",
						"h-9",
					)}
				>
					<div className="min-w-0 flex-1">
						<div className="truncate font-mono text-xs text-text-muted" title={path}>
							{path}
						</div>
					</div>
					{fileActions}
				</div>
			)}
			<ContextMenu onOpenChange={(menuOpen) => !menuOpen && setSelectionLineRange(null)}>
				<ContextMenuTrigger asChild>
					<div className="min-h-0 flex-1 overflow-hidden bg-transparent">
						{loading && preview === null ? (
							<LoadingTransition label={t("explorer.previewLoading")} className="h-full min-h-56" />
						) : error !== null && preview === null ? (
							<PreviewState
								icon={TriangleAlert}
								title={t("explorer.previewFailedTitle")}
								description={error}
								action={{ label: t("explorer.retry"), onClick: reload }}
							/>
						) : preview?.kind === "text" && rendered ? (
							<RenderedFile
								key={`${props.viewKey}\0${cwd}\0${path}`}
								cwd={cwd}
								path={path}
								onOpenFile={props.onOpenFile}
								text={content}
								initialScrollTop={props.view?.scrollTop ?? 0}
								onViewChange={props.onViewChange}
							/>
						) : preview?.kind === "text" ? (
							<Suspense fallback={<LoadingTransition label={t("explorer.previewLoading")} className="h-full" />}>
								<MonacoFileEditor
									onOpenFile={props.onOpenFile}
									onInsertReference={props.onInsertReference}
									viewKey={props.viewKey ?? cwd}
									cwd={cwd}
									path={path}
									document={preview}
									saving={saving}
									saveError={saveError}
									onSave={save}
									onSelectionLineRangeChange={setSelectionLineRange}
									{...(editorOwnsToolbar ? { toolbarActions: fileActions } : {})}
								/>
							</Suspense>
						) : preview?.kind === "image" && imageUrl !== null ? (
							<div className="workspace-image-preview grid h-full min-h-56 place-items-center overflow-auto p-5">
								<img
									src={imageUrl}
									alt={t("explorer.imageAlt", { path })}
									className="max-h-full max-w-full rounded-control border border-border-subtle object-contain shadow-sm"
								/>
							</div>
						) : preview?.kind === "binary" ? (
							<PreviewState
								icon={Binary}
								title={t("explorer.binaryTitle")}
								description={t("explorer.binaryDescription", {
									size: formatWorkspaceFileSize(preview.size, locale),
								})}
							/>
						) : preview?.kind === "tooLarge" ? (
							<PreviewState
								icon={FileWarning}
								title={t("explorer.tooLargeTitle")}
								description={t("explorer.tooLargeDescription", {
									size: formatWorkspaceFileSize(preview.size, locale),
									limit: formatWorkspaceFileSize(preview.maxBytes, locale),
								})}
							/>
						) : (
							<PreviewState
								icon={FileQuestion}
								title={t("explorer.selectFileTitle")}
								description={t("explorer.selectFileDescription")}
							/>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="w-52">
					{selectionLineRange !== null && (
						<ContextMenuItem onSelect={insertSelectionReference}>
							<AtSign aria-hidden="true" />
							{selectionLineRange.start === selectionLineRange.end
								? t("explorer.addLineToChat", { line: selectionLineRange.start })
								: t("explorer.addSelectionToChat", {
										start: selectionLineRange.start,
										end: selectionLineRange.end,
									})}
						</ContextMenuItem>
					)}
					<ContextMenuItem onSelect={() => onInsertReference(path)}>
						<AtSign aria-hidden="true" />
						{t("explorer.addToChat")}
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		</div>
	);
}

function RenderedFile({
	cwd,
	path,
	onOpenFile,
	text,
	initialScrollTop,
	onViewChange,
}: {
	cwd: string;
	path: string;
	onOpenFile: (path: string) => void;
	text: string;
	initialScrollTop: number;
	onViewChange: WorkspaceFilePreviewProps["onViewChange"];
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const document = useMemo(
		() => ({
			// URL fragments and queries do not belong to the file path; escaped filename characters still do.
			resolve: (source: string) =>
				resolveProjectPath(source.replace(/[?#].*$/, ""), cwd, { documentPath: path, sourceKind: "url" }),
			open: onOpenFile,
		}),
		[cwd, path, onOpenFile],
	);
	const initial = useRef(initialScrollTop);
	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		let top = initial.current;
		let restoring = true;
		const restore = () => {
			if (!restoring) return;
			element.scrollTop = top;
			if (element.scrollTop >= top) restoring = false;
		};
		const remember = () => {
			if (!restoring) top = element.scrollTop;
		};
		const stopRestoring = () => {
			restoring = false;
			top = element.scrollTop;
		};
		element.addEventListener("scroll", remember);
		element.addEventListener("wheel", stopRestoring, { passive: true });
		element.addEventListener("pointerdown", stopRestoring);
		element.addEventListener("keydown", stopRestoring);
		// Markdown and lazy images can publish their height after the first effect.
		const observer = new ResizeObserver(restore);
		observer.observe(element);
		if (element.firstElementChild) observer.observe(element.firstElementChild);
		restore();
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", remember);
			element.removeEventListener("wheel", stopRestoring);
			element.removeEventListener("pointerdown", stopRestoring);
			element.removeEventListener("keydown", stopRestoring);
			// Detached scrollports report zero. Save the last observed position instead.
			onViewChange?.({ scrollTop: top });
		};
	}, [onViewChange]);
	return (
		<div ref={scrollRef} data-file-markdown="" className="h-full overflow-auto px-6 py-5">
			<MarkdownImageRootContext.Provider value={cwd}>
				<MarkdownDocumentContext.Provider value={document}>
					<Markdown text={text} className="mx-auto max-w-5xl" smooth={false} />
				</MarkdownDocumentContext.Provider>
			</MarkdownImageRootContext.Provider>
		</div>
	);
}
