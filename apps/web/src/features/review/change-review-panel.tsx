import { Input } from "@renderer/components/ui/input";
import { useMemo, useState } from "react";
import { ChevronRight, Folder, Search } from "lucide-react";
import { WorkbenchReadingPane } from "@renderer/components/workbench/workbench-reading-pane";
import { EmptyState } from "@renderer/components/ui/empty-state";
import type { ChangeReviewFile, ChangeReviewScope, ChangeReviewSnapshot } from "@ling/contracts/git";

import type { SessionRef } from "@ling/contracts/session-ref";

import { DataHealthLink } from "@renderer/components/data-health/data-health";

import { FeedbackNotice } from "@renderer/components/ui/feedback";

import { LoadingTransition } from "@renderer/components/ui/loading-transition";

import { WorkbenchDialog } from "@renderer/components/workbench-dialog";

import { cn } from "@renderer/lib/utils";

import { RefreshCw } from "lucide-react";

import { useTranslation } from "react-i18next";

import { ChangedFileRow } from "./change-review-file-row";

import { ChangeReviewHeader, ChangeReviewScopeTabs } from "./change-review-header";

import { ChangeReviewDetailPane } from "./change-review-preview";

import { countReviewed, isFileReviewed } from "./change-review-reviewed";
import type { ReviewedMap } from "@ling/contracts/user-state";

import { ChangeReviewCommitDialog, ChangeReviewDiscardDialog } from "./change-review-write-flow";

import { useChangeReviewDiffPreview } from "./use-change-review-diff-preview";

import { useChangeReviewPanel, type ChangeReviewPanelProps } from "./use-change-review-panel";
import { useReviewCommentAppender } from "./use-review-comment-appender";

function ChangeReviewTotals({ files }: { files: readonly ChangeReviewFile[] }) {
	const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
	const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
	if (additions === 0 && deletions === 0) return null;
	return (
		<span className="inline-flex items-center gap-1 font-mono leading-none tabular-nums">
			<span className="text-git-added">+{additions}</span>
			<span className="text-git-deleted">−{deletions}</span>
		</span>
	);
}

function ChangeReviewFileList({
	files,
	scope,
	selectedPath,
	reviewedMap,
	onToggleReviewed,
	onSelect,
	emptyMessage,
	emptyTone = "info",
	className,
}: {
	files: readonly ChangeReviewFile[];
	scope: ChangeReviewScope;
	selectedPath: string | null;
	reviewedMap: ReviewedMap;
	onToggleReviewed: (file: ChangeReviewFile) => void;
	onSelect: (path: string) => void;
	emptyMessage: string;
	emptyTone?: "info" | "danger" | undefined;
	className?: string | undefined;
}) {
	const { t } = useTranslation();
	const reviewedCount = countReviewed(reviewedMap, files);
	const [query, setQuery] = useState("");
	const tree = useMemo(() => {
		type Directory = { path: string; name: string; directories: Map<string, Directory>; files: ChangeReviewFile[] };
		const root: Directory = { path: "", name: "", directories: new Map(), files: [] };
		for (const file of files) {
			if (!file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) continue;
			const parts = file.path.replaceAll("\\", "/").split("/");
			parts.pop();
			let parent = root;
			for (const name of parts) {
				if (!name) continue;
				let directory = parent.directories.get(name);
				if (!directory) {
					directory = { name, path: `${parent.path}/${name}`, directories: new Map(), files: [] };
					parent.directories.set(name, directory);
				}
				parent = directory;
			}
			parent.files.push(file);
		}
		return root;
	}, [files, query]);
	const renderDirectory = (directory: typeof tree): React.ReactNode => (
		<>
			{[...directory.directories.values()]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((child) => (
					<details key={child.path} open className="[&[open]>summary>svg:first-child]:rotate-90">
						<summary className="flex min-h-7 cursor-default list-none items-center gap-1.5 rounded-control px-1 text-xs text-text-muted hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
							<ChevronRight className="size-3 shrink-0" aria-hidden="true" />
							<Folder className="size-3.5 shrink-0" aria-hidden="true" />
							<span className="truncate" title={child.path}>
								{child.name}
							</span>
						</summary>
						<div className="pl-2.5">{renderDirectory(child)}</div>
					</details>
				))}
			{directory.files.map((file) => (
				<ChangedFileRow
					key={`${file.owner}:${file.status}:${file.from ?? ""}:${file.path}`}
					file={file}
					nested
					selected={file.path === selectedPath}
					showOwner={scope === "workspace"}
					reviewed={isFileReviewed(reviewedMap, file)}
					onToggleReviewed={() => onToggleReviewed(file)}
					onSelect={() => onSelect(file.path)}
				/>
			))}
		</>
	);

	return (
		<div className={cn("change-review-files flex min-h-0 flex-col p-2", className)}>
			<div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-1 px-1 text-xs text-text-muted">
				<span>{t("changes.count", { count: files.length })}</span>
				<span className="flex items-center gap-2">
					{files.length > 0 && (
						<span className={cn("tabular-nums", reviewedCount === files.length ? "text-git-added" : undefined)}>
							{t("changes.reviewedCount", { reviewed: reviewedCount, total: files.length })}
						</span>
					)}
					<ChangeReviewTotals files={files} />
				</span>
			</div>
			<div className="relative mb-2 shrink-0">
				<Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-text-muted" aria-hidden="true" />
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					aria-label={t("reading.filterFiles")}
					placeholder={t("reading.filterFiles")}
					className="h-8 pl-8 text-xs shadow-none"
				/>
			</div>
			{files.length === 0 ? (
				<div className="px-1 py-1">
					{emptyTone === "danger" ? (
						<FeedbackNotice tone="danger">{emptyMessage}</FeedbackNotice>
					) : (
						<EmptyState variant="inline" title={emptyMessage} />
					)}
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					{tree.directories.size === 0 && tree.files.length === 0 ? (
						<EmptyState variant="inline" title={t("reading.noFiles")} />
					) : (
						renderDirectory(tree)
					)}
				</div>
			)}
		</div>
	);
}

function ChangeReviewPanelDetail({
	sessionRef,
	snapshot,
	scope,
	historicalTurnId,
	selectedFile,
	onBack,
}: {
	sessionRef: SessionRef;
	snapshot: ChangeReviewSnapshot;
	scope: ChangeReviewScope;
	historicalTurnId: string | null;
	selectedFile: ChangeReviewFile | null;
	onBack: () => void;
}) {
	const preview = useChangeReviewDiffPreview({
		open: true,
		sessionRef,
		snapshot,
		scope,
		historicalTurnId,
		selectedPath: selectedFile?.path ?? null,
	});
	const addReviewComment = useReviewCommentAppender(sessionRef);
	const imageRevisions =
		scope === "unpushed" && snapshot.unpushed.status === "ready"
			? { base: snapshot.unpushed.baseSha, current: snapshot.unpushed.headSha }
			: undefined;
	return (
		<ChangeReviewDetailPane
			cwd={sessionRef.cwd}
			selectedFile={selectedFile}
			visiblePreview={preview.visiblePreview}
			previewError={preview.previewError}
			loadingPreview={preview.loadingPreview}
			canExpandDiffContext={preview.canExpandDiffContext}
			imageBaseAvailable={scope !== "turn" && scope !== "committed"}
			imageRevisions={imageRevisions}
			onExpandContext={preview.expandDiffContext}
			onAddComment={addReviewComment}
			onBack={onBack}
		/>
	);
}
export function ChangeReviewPanel(props: ChangeReviewPanelProps) {
	const {
		docked,
		branchDescription,
		open,
		nestedDialogOpen,
		t,
		panelDescription,
		handlePanelOpenChange,
		snapshot,
		stateRecoveryError,
		error,
		scope,
		canChange,
		loading,
		selectedFile,
		canChangeScope,
		files,
		writes,
		onRefresh,
		onCopyPath,
		closePanel,
		changeScope,
		tracking,
		partialTrackingMessageKey,
		navigatorOnly,
		selectedPath,
		reviewed,
		selectFile,
		emptyMessage,
		emptyTone,
		sessionRef,
		viewingHistoricalTurn,
		requestedTurnId,
		dispatchNavigation,
	} = useChangeReviewPanel(props);

	return (
		<WorkbenchDialog
			docked={docked}
			open={open}
			nestedDialogOpen={nestedDialogOpen}
			title={t("changes.reviewTitle")}
			description={panelDescription}
			onOpenChange={handlePanelOpenChange}
			containerClassName="change-review-container"
			panelClassName="change-review-panel"
		>
			<div className="bg-workbench-surface">
				<ChangeReviewHeader
					snapshot={snapshot}
					secondaryDescription={snapshot !== null || stateRecoveryError !== null || error !== null}
					description={panelDescription}
					showWriteActions={scope !== "unpushed"}
					canChange={canChange}
					loading={loading}
					copyPath={selectedFile?.path ?? null}
					onDiscard={() =>
						snapshot &&
						canChangeScope(scope, files) &&
						writes.openDiscardDialog(snapshot.snapshotId, scope, files.length)
					}
					onCommit={() =>
						snapshot &&
						canChangeScope(scope, files) &&
						writes.openCommitDialog(snapshot.snapshotId, scope, files.length)
					}
					onRefresh={onRefresh}
					onCopyPath={onCopyPath}
					onClose={docked ? undefined : closePanel}
					compact={docked}
					leading={props.headerLeading}
					descriptionShown={!(props.headerLeading !== undefined && branchDescription)}
				/>
				{snapshot && (
					<ChangeReviewScopeTabs
						snapshot={snapshot}
						scope={scope}
						turnFileCount={files.length}
						onChangeScope={changeScope}
					/>
				)}
				{tracking?.status === "capturing" && (
					<div
						role="status"
						className="flex items-start gap-2 border-b border-border-subtle bg-surface-muted/35 px-3 py-2 text-xs text-text-muted"
					>
						<RefreshCw className="mt-0.5 size-3 shrink-0 animate-spin" aria-hidden="true" />
						<span>{t("changes.trackingCapturing")}</span>
					</div>
				)}
				{tracking?.status === "partial" && (
					<div className="border-b border-border-subtle px-3 py-2">
						<FeedbackNotice tone="warning" className="rounded-control px-3 py-2 text-xs">
							{t(partialTrackingMessageKey(tracking.reason))}
						</FeedbackNotice>
					</div>
				)}
			</div>
			{stateRecoveryError ? (
				<div className="flex min-h-0 flex-1 flex-col items-stretch gap-3 p-3 text-xs">
					<FeedbackNotice tone="danger" title={t("changes.stateReadErrorTitle")}>
						<p className="whitespace-pre-wrap text-text-muted">
							{t("changes.stateReadErrorDescription", { message: stateRecoveryError })}
						</p>
					</FeedbackNotice>
					<DataHealthLink />
				</div>
			) : error ? (
				<div className="flex min-h-0 flex-1 items-start p-3">
					<FeedbackNotice tone="danger" className="w-full text-xs">
						<p className="whitespace-pre-wrap">{error}</p>
					</FeedbackNotice>
				</div>
			) : snapshot === null ? (
				<LoadingTransition label={t("changes.loading")} className="min-h-0 flex-1" />
			) : navigatorOnly ? (
				<ChangeReviewFileList
					files={files}
					scope={scope}
					selectedPath={selectedPath}
					reviewedMap={reviewed.reviewedMap}
					onToggleReviewed={reviewed.toggleFileReviewed}
					onSelect={selectFile}
					emptyMessage={emptyMessage}
					emptyTone={emptyTone}
					className="flex-1"
				/>
			) : (
				<WorkbenchReadingPane
					navigationLabel={t("changes.reviewTitle")}
					selectionKey={selectedPath}
					navigation={
						<ChangeReviewFileList
							files={files}
							scope={scope}
							selectedPath={selectedPath}
							reviewedMap={reviewed.reviewedMap}
							onToggleReviewed={reviewed.toggleFileReviewed}
							onSelect={selectFile}
							emptyMessage={emptyMessage}
							emptyTone={emptyTone}
							className="flex-1"
						/>
					}
				>
					<ChangeReviewPanelDetail
						sessionRef={sessionRef}
						snapshot={snapshot}
						scope={scope}
						historicalTurnId={viewingHistoricalTurn ? requestedTurnId : null}
						selectedFile={selectedFile}
						onBack={() => dispatchNavigation({ type: "showFiles" })}
					/>
				</WorkbenchReadingPane>
			)}
			<ChangeReviewCommitDialog
				target={writes.commitTarget}
				message={writes.commitMessage}
				error={writes.commitError}
				committing={writes.committing}
				onMessageChange={writes.setCommitMessage}
				onClose={writes.closeCommitDialog}
				onCommit={writes.commitScope}
			/>
			<ChangeReviewDiscardDialog
				target={writes.discardTarget}
				error={writes.discardError}
				discarding={writes.discarding}
				onClose={writes.closeDiscardDialog}
				onDiscard={writes.discardScope}
			/>
		</WorkbenchDialog>
	);
}
