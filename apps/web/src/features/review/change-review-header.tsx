import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import type { ChangeReviewScope, ChangeReviewSnapshot } from "@ling/contracts/git";
import { WORKSPACE_PANEL_HEADER_CLASS } from "@renderer/components/shell-chrome";
import { Button } from "@renderer/components/ui/button";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { IconButton } from "@renderer/components/ui/icon-button";
import { cn } from "@renderer/lib/utils";
import { CircleAlert, Copy, GitCompareArrows, MoreHorizontal, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Panel title bar: description plus the discard/commit/refresh/copy/close actions. */
export function ChangeReviewHeader({
	snapshot,
	secondaryDescription,
	description,
	showWriteActions,
	canChange,
	loading,
	copyPath,
	onDiscard,
	onCommit,
	onRefresh,
	onCopyPath,
	onClose,
	compact = false,
}: {
	snapshot: ChangeReviewSnapshot | null;
	/** Renders the description line as soon as any of snapshot/recovery/error is present. */
	secondaryDescription: boolean;
	description: string;
	/** Unpushed commits are already committed, so discard/commit actions do not apply. */
	showWriteActions: boolean;
	canChange: boolean;
	loading: boolean;
	/** Selected file path offered to the clipboard; null disables the copy button. */
	copyPath: string | null;
	onDiscard: () => void;
	onCommit: () => void;
	onRefresh: () => void;
	onCopyPath: (path: string) => void;
	/** Absent when docked: the side panel's tab strip owns closing. */
	onClose?: (() => void) | undefined;
	/** Docked: one quiet row — the tab already carries the title. */
	compact?: boolean | undefined;
}) {
	const { t } = useTranslation();
	return (
		<div
			className={cn(
				compact ? "flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3" : "change-review-header",
				!compact && WORKSPACE_PANEL_HEADER_CLASS,
			)}
		>
			{!compact && <GitCompareArrows className="size-4 shrink-0 text-text-muted" aria-hidden="true" />}
			<div aria-hidden="true" className="change-review-heading min-w-0 flex-1">
				{!compact && <div className="truncate text-xs font-medium text-text-primary">{t("changes.reviewTitle")}</div>}
				{secondaryDescription && <div className="truncate text-xs text-text-muted">{description}</div>}
			</div>
			<div className="change-review-actions flex shrink-0 items-center gap-2">
				{snapshot?.isRepository !== false && showWriteActions && (
					<>
						<DropdownMenu>
							<DropdownMenuTrigger render={<IconButton type="button" aria-label={t("common.moreActions")} />}>
								<MoreHorizontal className="size-4" aria-hidden="true" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem disabled={!canChange} onSelect={onDiscard} className="text-danger">
									{t("changes.discard")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<Button type="button" size="sm" onClick={onCommit} disabled={!canChange} className="h-7 px-2 text-xs">
							{t("git.commit")}
						</Button>
					</>
				)}
				<TooltipIconButton label={t("changes.refresh")} onClick={onRefresh}>
					<RefreshCw
						className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")}
						aria-hidden="true"
					/>
				</TooltipIconButton>
				<TooltipIconButton
					label={t("changes.copyPath")}
					onClick={() => copyPath !== null && onCopyPath(copyPath)}
					disabled={copyPath === null}
				>
					<Copy className="size-4" aria-hidden="true" />
				</TooltipIconButton>
				{onClose && (
					<TooltipIconButton label={t("changes.close")} onClick={onClose}>
						<X className="size-4" aria-hidden="true" />
					</TooltipIconButton>
				)}
			</div>
		</div>
	);
}

/** Session/workspace scope pills plus the dismissible historical-turn chip. */
export function ChangeReviewScopeTabs({
	snapshot,
	scope,
	turnFileCount,
	onChangeScope,
}: {
	snapshot: ChangeReviewSnapshot;
	scope: ChangeReviewScope;
	/** File count shown on the turn chip; only rendered while scope === "turn". */
	turnFileCount: number;
	onChangeScope: (scope: "session" | "workspace" | "unpushed") => void;
}) {
	const { t } = useTranslation();
	const unpushedTitle =
		snapshot.unpushed.status === "ready"
			? t("changes.unpushedAgainst", {
					count: snapshot.unpushed.commitCount,
					ref: snapshot.unpushed.comparisonRef,
				})
			: snapshot.unpushed.status === "error"
				? t("changes.unpushedLoadFailed", { message: snapshot.unpushed.message })
				: t("changes.unpushedNoUpstream");
	const unpushedFailed = snapshot.unpushed.status === "error";
	return (
		<div className="flex flex-wrap items-center gap-1 border-b border-border-subtle px-3 py-2">
			{/* Session ownership, uncommitted files, and local commits answer distinct review questions.
			    Source attribution stays on uncommitted workspace rows as inline chips. */}
			<button
				type="button"
				onClick={() => onChangeScope("session")}
				aria-pressed={scope === "session" || scope === "turn"}
				className={cn(
					"rounded-full px-3 py-1 text-xs transition-colors",
					scope === "session" || scope === "turn"
						? "bg-surface-hover font-medium text-text-primary"
						: "text-text-muted hover:bg-surface-hover hover:text-text-primary",
				)}
			>
				{t("changes.tabSession")}
				<span className="ml-1 font-mono text-xs tabular-nums text-text-muted">{snapshot.scopes.session.count}</span>
			</button>
			{snapshot.isRepository && (
				<>
					<button
						type="button"
						onClick={() => onChangeScope("workspace")}
						aria-pressed={scope === "workspace"}
						className={cn(
							"inline-flex items-center rounded-full px-3 py-1 text-xs transition-colors",
							scope === "workspace"
								? "bg-surface-hover font-medium text-text-primary"
								: "text-text-muted hover:bg-surface-hover hover:text-text-primary",
						)}
					>
						{t("changes.tabWorkspace")}
						<span className="ml-1 font-mono text-xs tabular-nums text-text-muted">
							{snapshot.scopes.workspace.count}
						</span>
					</button>
					<button
						type="button"
						onClick={() => onChangeScope("unpushed")}
						aria-pressed={scope === "unpushed"}
						title={unpushedTitle}
						className={cn(
							"inline-flex items-center rounded-full px-3 py-1 text-xs transition-colors",
							scope === "unpushed"
								? "bg-surface-hover font-medium text-text-primary"
								: "text-text-muted hover:bg-surface-hover hover:text-text-primary",
						)}
					>
						{t("changes.tabUnpushed")}
						{unpushedFailed ? (
							<CircleAlert className="ml-1 size-3 text-danger" aria-label={unpushedTitle} />
						) : (
							<span className="ml-1 font-mono text-xs tabular-nums text-text-muted">
								{snapshot.scopes.unpushed.count}
							</span>
						)}
					</button>
				</>
			)}
			{scope === "turn" && (
				<button
					type="button"
					onClick={() => onChangeScope("session")}
					className="ml-auto flex min-h-6 items-center gap-1 rounded-full border border-dashed border-border-subtle px-2.5 py-0.5 text-xs text-accent transition-colors hover:bg-surface-hover"
				>
					{t("changes.turnOnly", { count: turnFileCount })}
					<X className="size-3" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}
