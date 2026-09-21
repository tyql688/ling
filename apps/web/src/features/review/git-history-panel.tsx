import type { GitGraph, GitGraphRef } from "@ling/contracts/git";
import { WORKSPACE_PANEL_HEADER_CLASS, WORKSPACE_SUBHEADER_CLASS } from "@renderer/components/shell-chrome";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { WorkbenchDialog } from "@renderer/components/workbench-dialog";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { Check, GitBranch, GitCommitHorizontal, GitFork, Plus, RefreshCw, Search, Tag, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommitChanges } from "./commit-changes";
import { GitGraphCell } from "./git-graph";
import { type GitGraphRow, layoutGitGraph } from "./git-graph-layout";

function refsByCommit(graph: GitGraph | null): Map<string, GitGraphRef[]> {
	const grouped = new Map<string, GitGraphRef[]>();
	for (const ref of graph?.refs ?? []) {
		const refs = grouped.get(ref.commit) ?? [];
		refs.push(ref);
		grouped.set(ref.commit, refs);
	}
	return grouped;
}

function graphRowMatches(row: GitGraphRow, refs: readonly GitGraphRef[], query: string): boolean {
	if (query.length === 0) return true;
	return (
		row.commit.sha.includes(query) ||
		row.commit.subject.toLowerCase().includes(query) ||
		row.commit.author.toLowerCase().includes(query) ||
		refs.some((ref) => ref.name.toLowerCase().includes(query))
	);
}

function RefBadge({
	gitRef,
	currentBranch,
	busy,
	onSwitch,
}: {
	gitRef: GitGraphRef;
	currentBranch: string | null;
	busy: boolean;
	onSwitch: (branch: string) => void;
}) {
	const { t } = useTranslation();
	const current = gitRef.kind === "local" && gitRef.name === currentBranch;
	const icon =
		gitRef.kind === "tag" ? (
			<Tag className="size-2.5" aria-hidden="true" />
		) : gitRef.kind === "remote" ? (
			<GitFork className="size-2.5" aria-hidden="true" />
		) : (
			<GitBranch className="size-2.5" aria-hidden="true" />
		);
	const className = cn(
		"inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 font-mono text-xs",
		current
			? "border-text-primary bg-text-primary text-surface"
			: "border-border-subtle bg-surface-raised text-text-muted",
		gitRef.kind === "local" && !current && "hover:bg-surface-hover hover:text-text-primary",
	);
	const title =
		gitRef.kind === "local"
			? current
				? t("git.currentBranch")
				: t("git.switchBranch", { branch: gitRef.name })
			: t(`git.ref.${gitRef.kind}`);

	if (gitRef.kind !== "local" || current) {
		return (
			<span className={className} title={title}>
				{icon}
				{gitRef.name}
				{current && <Check className="size-2.5" aria-hidden="true" />}
			</span>
		);
	}
	return (
		<button
			type="button"
			className={className}
			title={title}
			aria-label={title}
			disabled={busy}
			onClick={() => onSwitch(gitRef.name)}
		>
			{icon}
			{gitRef.name}
		</button>
	);
}

function HistoryRow({
	row,
	columnCount,
	headSha,
	refs,
	currentBranch,
	busy,
	showTopology,
	onSwitch,
	cwd,
	expanded,
	onToggle,
}: {
	row: GitGraphRow;
	columnCount: number;
	headSha: string | null;
	refs: readonly GitGraphRef[];
	currentBranch: string | null;
	busy: boolean;
	showTopology: boolean;
	onSwitch: (branch: string) => void;
	cwd: string;
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<li className="min-w-0">
			<div
				role="button"
				tabIndex={0}
				aria-expanded={expanded}
				onClick={onToggle}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onToggle();
				}}
				className={cn(
					"flex h-[38px] min-w-0 cursor-default items-center pr-2 text-xs hover:bg-surface-hover",
					expanded && "bg-surface-hover",
				)}
			>
				{showTopology ? (
					<GitGraphCell row={row} columnCount={columnCount} headSha={headSha} />
				) : (
					<span className="flex h-[38px] w-6 shrink-0 items-center justify-center text-text-muted">
						<GitCommitHorizontal className="size-3.5" aria-hidden="true" />
					</span>
				)}
				<div className="min-w-0 flex-1 leading-tight">
					<div className="truncate text-text-primary" title={row.commit.subject}>
						{row.commit.subject || row.commit.sha.slice(0, 8)}
					</div>
					<div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-xs text-text-muted">
						<span>{row.commit.sha.slice(0, 8)}</span>
						<span className="truncate">{row.commit.author}</span>
						<span className="shrink-0">{relativeTime(row.commit.authoredAt)}</span>
					</div>
				</div>
				{refs.length > 0 && (
					<div className="git-history-refs ml-2 flex max-w-64 shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
						{refs.map((gitRef) => (
							<RefBadge
								key={gitRef.fullName}
								gitRef={gitRef}
								currentBranch={currentBranch}
								busy={busy}
								onSwitch={onSwitch}
							/>
						))}
					</div>
				)}
			</div>
			{expanded && <CommitChanges cwd={cwd} sha={row.commit.sha} />}
		</li>
	);
}

export function GitHistoryPanel({
	cwd,
	open,
	nestedDialogOpen,
	graph,
	error,
	loading,
	query,
	currentBranch,
	busy,
	onQueryChange,
	onRefresh,
	onSwitch,
	onCreateBranch,
	onOpenChange,
}: {
	cwd: string;
	open: boolean;
	nestedDialogOpen: boolean;
	graph: GitGraph | null;
	error: string | null;
	loading: boolean;
	query: string;
	currentBranch: string | null;
	busy: boolean;
	onQueryChange: (query: string) => void;
	onRefresh: () => void;
	onSwitch: (branch: string) => void;
	onCreateBranch: () => void;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation();
	const layout = useMemo(() => layoutGitGraph(graph?.commits ?? []), [graph]);
	// One commit open at a time: the changes list is a per-commit read, and keeping several
	// expanded turns a scroll through history into a burst of git processes.
	const [expandedSha, setExpandedSha] = useState<string | null>(null);
	const commitRefs = useMemo(() => refsByCommit(graph), [graph]);
	const normalizedQuery = query.trim().toLowerCase();
	const visibleRows = layout.rows.filter((row) =>
		graphRowMatches(row, commitRefs.get(row.commit.sha) ?? [], normalizedQuery),
	);
	const loadedCommits = new Set(graph?.commits.map((commit) => commit.sha) ?? []);
	const olderLocalRefs = (graph?.refs ?? []).filter((ref) => {
		return ref.kind === "local" && !loadedCommits.has(ref.commit) && ref.name.toLowerCase().includes(normalizedQuery);
	});

	const subtitle = graph
		? t("git.historyCount", { count: graph.commits.length })
		: error
			? t("git.historyUnavailable")
			: t("git.loadingHistory");

	return (
		<WorkbenchDialog
			open={open}
			nestedDialogOpen={nestedDialogOpen}
			title={t("git.history")}
			description={t("git.historyDescription")}
			onOpenChange={onOpenChange}
			containerClassName="git-history-container"
			panelClassName="git-history-panel"
		>
			<div className={WORKSPACE_PANEL_HEADER_CLASS}>
				<GitBranch className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
				<div aria-hidden="true" className="min-w-0 flex-1">
					<div className="truncate text-xs font-medium text-text-primary">{t("git.history")}</div>
					<div className="truncate text-xs text-text-muted">{subtitle}</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<TooltipIconButton label={t("git.refreshHistory")} onClick={onRefresh} disabled={loading}>
						<RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden="true" />
					</TooltipIconButton>
					<TooltipIconButton label={t("git.createBranch")} onClick={onCreateBranch} disabled={busy}>
						<Plus className="size-4" aria-hidden="true" />
					</TooltipIconButton>
					<TooltipIconButton label={t("git.closeHistory")} onClick={() => onOpenChange(false)}>
						<X className="size-4" aria-hidden="true" />
					</TooltipIconButton>
				</div>
			</div>
			<div className={cn(WORKSPACE_SUBHEADER_CLASS, "gap-1.5")}>
				<Search className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
				<Input
					aria-label={t("git.searchHistory")}
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder={t("git.searchHistory")}
					className="h-7 border-0 bg-transparent px-0 text-xs shadow-none"
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{loading && graph === null ? (
					<LoadingTransition label={t("git.loadingHistory")} className="h-full min-h-24" />
				) : error ? (
					<div className="m-3">
						<FeedbackNotice tone="danger" title={t("git.historyUnavailable")} className="text-xs">
							<div className="break-words font-mono text-xs">{error}</div>
						</FeedbackNotice>
					</div>
				) : graph && visibleRows.length > 0 ? (
					<ul aria-label={t("git.history")}>
						{visibleRows.map((row) => (
							<HistoryRow
								key={row.commit.sha}
								row={row}
								columnCount={layout.columnCount}
								headSha={graph.headSha}
								refs={commitRefs.get(row.commit.sha) ?? []}
								currentBranch={currentBranch}
								busy={busy}
								showTopology={normalizedQuery.length === 0}
								onSwitch={onSwitch}
								cwd={cwd}
								expanded={expandedSha === row.commit.sha}
								onToggle={() => setExpandedSha((current) => (current === row.commit.sha ? null : row.commit.sha))}
							/>
						))}
					</ul>
				) : olderLocalRefs.length === 0 ? (
					<p className="px-3 py-8 text-center text-xs text-text-muted">
						{normalizedQuery.length > 0 ? t("git.noHistoryMatches") : t("git.historyEmpty")}
					</p>
				) : null}
				{olderLocalRefs.length > 0 && (
					<div className="mx-2 mt-1 border-border-subtle border-t pt-2">
						<div className="mb-1 px-1 text-xs font-medium tracking-wide text-text-muted uppercase">
							{t("git.olderBranches")}
						</div>
						<div className="flex flex-wrap gap-1 px-1 pb-1">
							{olderLocalRefs.map((gitRef) => (
								<RefBadge
									key={gitRef.fullName}
									gitRef={gitRef}
									currentBranch={currentBranch}
									busy={busy}
									onSwitch={onSwitch}
								/>
							))}
						</div>
					</div>
				)}
				{graph?.truncated && normalizedQuery.length === 0 && (
					<p className="px-3 py-2 text-center text-xs text-text-muted">{t("git.historyTruncated")}</p>
				)}
			</div>
		</WorkbenchDialog>
	);
}
