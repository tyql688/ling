import type { DiffScrollPosition } from "./diff-scroll-position";
import type { ChangeReviewSnapshot } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session-ref";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { cn } from "@renderer/lib/utils";
import { Check, Copy, ListTree, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChangeReviewDetailPane } from "./change-review-preview";
import { isFileReviewed } from "./change-review-reviewed";
import { filesForChangeReviewTarget, type ChangeReviewTarget } from "./change-review-target";
import { useChangeReviewDiffPreview } from "./use-change-review-diff-preview";
import { useChangeReviewReviewed } from "./use-change-review-reviewed";
import { useReviewCommentAppender } from "./use-review-comment-appender";

function scopeLabelKey(scope: ChangeReviewTarget["scope"]): string {
	switch (scope) {
		case "turn":
			return "changes.detailScopeTurn";
		case "session":
			return "changes.detailScopeSession";
		case "workspace":
			return "changes.detailScopeWorkspace";
		case "unpushed":
			return "changes.detailScopeUnpushed";
	}
}

export function ChangeReviewDetailTab({
	sessionRef,
	target,
	snapshot,
	loading,
	error,
	stateRecoveryError,
	scrollPosition,
	onOpenNavigator,
	onRefresh,
	onCopyPath,
}: {
	sessionRef: SessionRef;
	target: ChangeReviewTarget;
	snapshot: ChangeReviewSnapshot | null;
	loading: boolean;
	error: string | null;
	stateRecoveryError: string | null;
	scrollPosition: DiffScrollPosition;
	onOpenNavigator: () => void;
	onRefresh: () => void;
	onCopyPath: (path: string) => void;
}) {
	const { t } = useTranslation();
	const files = filesForChangeReviewTarget(snapshot, target);
	const selectedFile = files.find((file) => file.path === target.path) ?? null;
	const preview = useChangeReviewDiffPreview({
		open: selectedFile !== null,
		sessionRef,
		snapshot,
		scope: target.scope,
		historicalTurnId: target.scope === "turn" ? target.turnId : null,
		selectedPath: selectedFile?.path ?? null,
	});
	const addReviewComment = useReviewCommentAppender(sessionRef);
	const reviewed = useChangeReviewReviewed(sessionRef);
	const fileReviewed = selectedFile !== null && isFileReviewed(reviewed.reviewedMap, selectedFile);
	const loadWithoutSnapshot = snapshot === null && error === null && stateRecoveryError === null;
	const unavailableError = stateRecoveryError
		? t("changes.stateReadErrorDescription", { message: stateRecoveryError })
		: (error ?? (snapshot !== null && selectedFile === null ? t("changes.fileNoLongerChanged") : null));
	const detailError = unavailableError ?? preview.previewError;
	const imageRevisions =
		target.scope === "unpushed" && snapshot?.unpushed.status === "ready"
			? { base: snapshot.unpushed.baseSha, current: snapshot.unpushed.headSha }
			: undefined;
	const headerActions = (
		<div className="ml-auto flex shrink-0 items-center gap-0.5">
			<span className="mr-1 hidden rounded-full bg-surface-hover px-2 py-0.5 text-xs text-text-muted sm:inline-flex">
				{t(scopeLabelKey(target.scope))}
			</span>
			{selectedFile !== null && (
				<TooltipIconButton
					label={t(fileReviewed ? "changes.markUnreviewed" : "changes.markReviewed")}
					aria-pressed={fileReviewed}
					onClick={() => reviewed.toggleFileReviewed(selectedFile)}
					className={cn(fileReviewed && "text-git-added hover:text-git-added")}
				>
					<Check className="size-4" aria-hidden="true" />
				</TooltipIconButton>
			)}
			<TooltipIconButton label={t("changes.copyPath")} onClick={() => onCopyPath(target.path)}>
				<Copy className="size-4" aria-hidden="true" />
			</TooltipIconButton>
			<TooltipIconButton label={t("changes.showNavigator")} onClick={onOpenNavigator}>
				<ListTree className="size-4" aria-hidden="true" />
			</TooltipIconButton>
			<TooltipIconButton label={t("changes.refresh")} onClick={onRefresh}>
				<RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden="true" />
			</TooltipIconButton>
		</div>
	);

	return (
		<section aria-label={t("changes.diffTabTitle", { path: target.path })} className="flex min-h-0 min-w-0 flex-1">
			<ChangeReviewDetailPane
				cwd={sessionRef.cwd}
				selectedFile={selectedFile}
				displayPath={target.path}
				visiblePreview={preview.visiblePreview}
				previewError={detailError}
				loadingPreview={
					((loadWithoutSnapshot || (loading && selectedFile === null)) && detailError === null) ||
					preview.loadingPreview
				}
				canExpandDiffContext={preview.canExpandDiffContext}
				imageBaseAvailable={target.scope !== "turn"}
				imageRevisions={imageRevisions}
				onExpandContext={preview.expandDiffContext}
				onAddComment={addReviewComment}
				scrollPosition={scrollPosition}
				headerActions={headerActions}
				seamless
			/>
		</section>
	);
}
