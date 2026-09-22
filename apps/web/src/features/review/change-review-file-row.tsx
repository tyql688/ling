import type { ChangeReviewFile } from "@ling/contracts/git";
import { tildify } from "@renderer/lib/format-path";
import { cn } from "@renderer/lib/utils";
import { useTranslation } from "react-i18next";
import { changedFileLabel } from "./changed-file-label";

/** Git status → badge palette classes; aligned with the workspace tree/diff color tokens. */
const STATUS_TONE: Record<ChangeReviewFile["status"], string> = {
	modified: "border-git-modified/35 bg-git-modified/10 text-git-modified",
	added: "border-git-added/35 bg-git-added/10 text-git-added",
	deleted: "border-git-deleted/35 bg-git-deleted/10 text-git-deleted",
	renamed: "border-git-renamed/35 bg-git-renamed/10 text-git-renamed",
	copied: "border-git-renamed/35 bg-git-renamed/10 text-git-renamed",
	untracked: "border-git-untracked/35 bg-git-untracked/10 text-git-untracked",
	conflicted: "border-danger/40 bg-danger/10 text-danger",
	clean: "border-border-subtle bg-surface-hover text-text-muted",
};

/** Single-letter/symbol status badges (Git convention: M/A/D…), saving width on narrow rows. */
const STATUS_SHORT: Record<ChangeReviewFile["status"], string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	untracked: "U",
	conflicted: "!",
	clean: "✓",
};

function splitChangedPath(path: string): { directory: string; name: string } {
	const normalized = tildify(path);
	const separatorIndex = normalized.lastIndexOf("/");
	if (separatorIndex === -1) return { directory: "", name: normalized };
	return { directory: normalized.slice(0, separatorIndex), name: normalized.slice(separatorIndex + 1) };
}

function StatusBadge({ file }: { file: Pick<ChangeReviewFile, "status"> }) {
	const { t } = useTranslation();
	return (
		<span
			className={cn(
				"inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border font-mono text-xs font-medium",
				STATUS_TONE[file.status],
			)}
			title={t(`changes.status.${file.status}`)}
		>
			{STATUS_SHORT[file.status]}
		</span>
	);
}

export function ChangedFileRow({
	file,
	selected,
	showOwner,
	reviewed,
	onToggleReviewed,
	onSelect,
}: {
	file: ChangeReviewFile;
	selected?: boolean;
	/** Workspace tab only: label files that did not come from this session. */
	showOwner?: boolean;
	reviewed: boolean;
	onToggleReviewed: () => void;
	onSelect: () => void;
}) {
	const { t } = useTranslation();
	const { directory, name } = splitChangedPath(file.path);
	const hasStats = file.additions !== undefined || file.deletions !== undefined;
	const ownerChip = showOwner && file.owner !== "session" && file.owner !== "committed";
	return (
		<div
			className={cn(
				"flex w-full min-w-0 items-center gap-2 rounded-control pl-2 transition-colors",
				selected ? "bg-surface-hover" : "hover:bg-surface-hover",
			)}
		>
			<label
				className={cn(
					"relative flex size-3.5 shrink-0 cursor-default items-center justify-center rounded-sm border transition-colors has-[:focus-visible]:bg-accent/10",
					reviewed
						? "border-git-added/60 bg-git-added/15 text-git-added"
						: "border-border-strong text-transparent hover:border-text-muted",
				)}
			>
				<input
					type="checkbox"
					checked={reviewed}
					onChange={onToggleReviewed}
					aria-label={t("changes.markReviewed")}
					className="absolute inset-0 cursor-default opacity-0"
				/>
				<svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
					<path d="M1.5 5.5 4 8l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
				</svg>
			</label>
			<button
				type="button"
				onClick={onSelect}
				aria-pressed={selected}
				className={cn(
					"flex w-full min-w-0 items-center gap-2 rounded-control py-1.5 pr-2 text-left text-xs",
					selected ? "text-text-primary" : "text-text-muted",
				)}
				title={changedFileLabel(file)}
			>
				<StatusBadge file={file} />
				<span className="min-w-0 flex-1">
					<span className={cn("block truncate font-mono", reviewed ? "text-text-muted" : "text-text-primary")}>
						{name}
					</span>
					{directory && <span className="block truncate font-mono text-xs text-text-muted">{directory}</span>}
				</span>
				{ownerChip && (
					<span
						className={cn(
							"shrink-0 rounded-full px-1.5 py-px text-xs",
							file.owner === "external" || file.owner === "mixed"
								? "bg-warning/10 text-warning"
								: "bg-surface-hover text-text-muted",
						)}
					>
						{t(`changes.owner.${file.owner}`)}
					</span>
				)}
				{hasStats && (
					<span className="shrink-0 font-mono text-xs tabular-nums">
						<span className="text-git-added">+{file.additions ?? 0}</span>
						<span className="text-git-deleted"> −{file.deletions ?? 0}</span>
					</span>
				)}
			</button>
		</div>
	);
}
