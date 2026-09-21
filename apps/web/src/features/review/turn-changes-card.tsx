import type { ChangeReviewFile, ChangeReviewSnapshot } from "@ling/contracts/git";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { ArrowUpRight, ChevronDown, FileDiff, TriangleAlert, Undo2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { changedFileLabel } from "./changed-file-label";

export type ChangeReviewTurn = ChangeReviewSnapshot["turns"][number];

/** Number of files shown by default on a timeline change card; the rest collapse so one card cannot fill the viewport. */
const PREVIEW_FILE_LIMIT = 3;

function DiffStat({
	additions,
	deletions,
	className,
}: {
	additions: number;
	deletions: number;
	className?: string | undefined;
}) {
	if (additions === 0 && deletions === 0) return null;
	// leading-none + unicode minus keeps +/− on one mathematical axis; hyphen-minus sits low in mono.
	return (
		<span
			className={cn("inline-flex shrink-0 items-center gap-1 font-mono text-xs leading-none tabular-nums", className)}
		>
			{additions > 0 && <span className="text-git-added">+{additions}</span>}
			{deletions > 0 && <span className="text-git-deleted">−{deletions}</span>}
		</span>
	);
}

function summarizeFiles(files: readonly ChangeReviewFile[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const file of files) {
		additions += file.additions ?? 0;
		deletions += file.deletions ?? 0;
	}
	return { additions, deletions };
}

function FilePath({ file }: { file: ChangeReviewFile }) {
	if (file.from) {
		return <span className="min-w-0 flex-1 truncate text-text-muted">{changedFileLabel(file)}</span>;
	}
	const separatorIndex = file.path.lastIndexOf("/");
	const directory = separatorIndex === -1 ? "" : file.path.slice(0, separatorIndex + 1);
	const name = separatorIndex === -1 ? file.path : file.path.slice(separatorIndex + 1);
	return (
		<span className="min-w-0 flex-1 truncate font-mono text-xs">
			{directory && <span className="text-text-muted">{directory}</span>}
			<span className="text-text-primary">{name}</span>
		</span>
	);
}

export function TurnChangesCard({
	turn,
	expanded,
	onExpandedChange,
	onOpenFile,
	onReview,
	onRevert,
}: {
	turn: ChangeReviewTurn;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	onOpenFile: (path: string) => void;
	onReview: () => void;
	/** Offered only for fully captured turns; the host owns confirmation and execution. */
	onRevert?: (() => void) | undefined;
}) {
	const { t } = useTranslation();
	const files = turn.summary.files;
	const totals = useMemo(() => summarizeFiles(files), [files]);
	const orderedFiles = useMemo(
		() => files.toSorted((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true })),
		[files],
	);
	const visibleFiles = expanded ? orderedFiles : orderedFiles.slice(0, PREVIEW_FILE_LIMIT);
	const hiddenFileCount = Math.max(0, orderedFiles.length - PREVIEW_FILE_LIMIT);
	if (files.length === 0) return null;
	const hasTotals = totals.additions > 0 || totals.deletions > 0;
	return (
		<section
			aria-label={t("changes.turnCardEdited", { count: files.length })}
			className="skin-surface group/turn-card overflow-hidden rounded-panel border border-border-subtle bg-reading-surface text-xs"
		>
			<header className="flex min-h-16 items-center gap-3 px-3 py-2.5">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-hover text-text-muted">
					<FileDiff className="size-4" aria-hidden="true" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="truncate font-medium text-text-primary">
							{t("changes.turnCardEdited", { count: files.length })}
						</span>
						{turn.tracking.status === "partial" && (
							<span title={t("changes.turnCardPartial")} className="shrink-0 text-warning">
								<TriangleAlert className="size-3.5" aria-hidden="true" />
							</span>
						)}
					</div>
					{/* Idle: +/− totals. Hover (card): swap to View changes → onReview. */}
					<div className="relative mt-0.5 flex h-4 items-center">
						{hasTotals ? (
							<DiffStat
								additions={totals.additions}
								deletions={totals.deletions}
								className="transition-opacity group-hover/turn-card:pointer-events-none group-hover/turn-card:opacity-0"
							/>
						) : null}
						<button
							type="button"
							onClick={onReview}
							className={cn(
								"absolute inset-y-0 left-0 inline-flex items-center gap-0.5 text-xs text-text-muted transition-opacity hover:text-text-primary",
								hasTotals
									? "pointer-events-none opacity-0 group-hover/turn-card:pointer-events-auto group-hover/turn-card:opacity-100"
									: "opacity-100",
							)}
						>
							{t("changes.turnCardViewChanges")}
							<ArrowUpRight className="size-3" aria-hidden="true" />
						</button>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{onRevert && (
						<button
							type="button"
							onClick={onRevert}
							aria-label={t("changes.revertTurn")}
							className="inline-flex h-7 items-center gap-1 rounded-control px-2 text-xs text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
						>
							{t("changes.revertTurnAction")}
							<Undo2 className="size-3.5" aria-hidden="true" />
						</button>
					)}
					<Button type="button" variant="outline" size="sm" onClick={onReview} className="h-7 px-2.5">
						{t("changes.turnCardReview")}
					</Button>
				</div>
			</header>
			<div className="border-border-subtle border-t py-1">
				{visibleFiles.map((file) => (
					<button
						key={`${file.status}:${file.from ?? ""}:${file.path}`}
						type="button"
						onClick={() => onOpenFile(file.path)}
						title={changedFileLabel(file)}
						className="flex h-9 w-full min-w-0 items-center gap-3 px-3 text-left transition-colors hover:bg-surface-hover"
					>
						<FilePath file={file} />
						<DiffStat additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
					</button>
				))}
				{hiddenFileCount > 0 && (
					<button
						type="button"
						onClick={() => onExpandedChange(!expanded)}
						aria-expanded={expanded}
						className="flex h-8 items-center gap-1.5 px-3 text-xs text-text-muted transition-colors hover:text-text-primary"
					>
						{expanded ? t("changes.turnCardCollapse") : t("changes.turnCardMoreFiles", { count: hiddenFileCount })}
						<ChevronDown
							className={cn("size-3.5 transition-transform motion-reduce:transition-none", expanded && "rotate-180")}
							aria-hidden="true"
						/>
					</button>
				)}
			</div>
		</section>
	);
}
