import { useDomainApi } from "@renderer/lib/host-api-context";
import type { GitChangedFile } from "@ling/contracts/git";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { DiffView } from "@renderer/features/review/diff-view";
import { formatRequestError } from "@renderer/lib/errors";
import { cn } from "@renderer/lib/utils";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type FilesState =
	{ kind: "loading" } | { kind: "loaded"; files: GitChangedFile[] } | { kind: "failed"; message: string };

type PatchState = { kind: "loading" } | { kind: "loaded"; diff: string } | { kind: "failed"; message: string };

/** Single-letter status marker, matching how git itself abbreviates each change. */
const STATUS_LETTER: Record<string, string> = {
	added: "A",
	deleted: "D",
	modified: "M",
	renamed: "R",
	copied: "C",
};

/**
 * The files one commit changed, fetched only when the user opens that commit.
 *
 * The graph deliberately carries nothing but commit ids and parents, so a history of thousands
 * of commits costs one `git log`. Everything below is a second, per-commit read — the same split
 * VS Code makes between its history items and `provideHistoryItemChanges`.
 */
export function CommitChanges({ cwd, sha }: { cwd: string; sha: string }) {
	const hostGitApi = useDomainApi("git");

	const { t } = useTranslation();
	const [state, setState] = useState<FilesState>({ kind: "loading" });

	useEffect(() => {
		let cancelled = false;
		setState({ kind: "loading" });
		hostGitApi
			.getCommitChangedFiles({ cwd, sha })
			.then((files) => {
				if (!cancelled) setState({ kind: "loaded", files });
			})
			.catch((error: unknown) => {
				if (!cancelled) setState({ kind: "failed", message: formatRequestError(error, t) });
			});
		return () => {
			cancelled = true;
		};
	}, [hostGitApi, cwd, sha, t]);

	if (state.kind === "loading") return <LoadingTransition label={t("git.loadingCommitChanges")} className="min-h-16" />;
	if (state.kind === "failed") return <p className="px-3 py-2 text-xs text-danger">{state.message}</p>;
	if (state.files.length === 0) return <p className="px-3 py-2 text-xs text-text-muted">{t("git.commitNoChanges")}</p>;

	return (
		<ul className="border-t border-border-subtle bg-surface-raised/40">
			{state.files.map((file) => (
				<CommitChangedFileRow key={file.path} cwd={cwd} sha={sha} file={file} />
			))}
		</ul>
	);
}

function CommitChangedFileRow({ cwd, sha, file }: { cwd: string; sha: string; file: GitChangedFile }) {
	const hostGitApi = useDomainApi("git");

	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [patch, setPatch] = useState<PatchState | null>(null);

	// `patch` must stay out of the dependency list: setting it here would re-run the effect,
	// and the previous run's cleanup would cancel the request that is still in flight, leaving
	// the row stuck on its loading state forever.
	useEffect(() => {
		if (!expanded) return;
		let cancelled = false;
		setPatch({ kind: "loading" });
		hostGitApi
			.getCommitFileDiff({ cwd, sha, path: file.path })
			.then((diff) => {
				if (!cancelled) setPatch({ kind: "loaded", diff });
			})
			.catch((error: unknown) => {
				if (!cancelled) setPatch({ kind: "failed", message: formatRequestError(error, t) });
			});
		return () => {
			cancelled = true;
		};
	}, [hostGitApi, expanded, cwd, sha, file.path, t]);

	return (
		<li className="min-w-0">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded((current) => !current)}
				className="flex min-h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs hover:bg-surface-hover"
			>
				<ChevronRight
					className={cn("size-3 shrink-0 text-text-muted transition-transform", expanded && "rotate-90")}
					aria-hidden="true"
				/>
				<span
					className={cn(
						"w-3 shrink-0 text-center font-mono",
						file.status === "deleted" ? "text-danger" : file.status === "added" ? "text-success" : "text-text-muted",
					)}
				>
					{STATUS_LETTER[file.status] ?? "M"}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-text-primary" title={file.path}>
					{file.path}
				</span>
				{/* A binary file reports no counts; showing nothing beats showing a misleading zero. */}
				{file.additions !== undefined && <span className="shrink-0 font-mono text-success">+{file.additions}</span>}
				{file.deletions !== undefined && <span className="shrink-0 font-mono text-danger">−{file.deletions}</span>}
			</button>
			{expanded && patch !== null && (
				<div className="border-t border-border-subtle">
					{patch.kind === "loading" && <LoadingTransition label={t("git.loadingDiff")} className="min-h-16" />}
					{patch.kind === "failed" && <p className="px-3 py-2 text-xs text-danger">{patch.message}</p>}
					{patch.kind === "loaded" && <DiffView diff={patch.diff} showFilename={false} />}
				</div>
			)}
		</li>
	);
}
