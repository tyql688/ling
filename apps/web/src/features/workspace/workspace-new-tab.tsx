import type { ProjectMentionItem } from "@ling/contracts/project";
import { MaterialFileIcon } from "@renderer/components/material-code-icon";
import { Input } from "@renderer/components/ui/input";
import {
	featurePageIcons,
	featurePageTitleKeys,
	formatFeatureCount,
	type FeaturePageId,
} from "@renderer/components/workbench/feature-navigation";
import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { StatusBadge } from "@renderer/features/review/change-review-file-row";
import { splitChangedPath } from "@renderer/features/review/changed-file-label";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { shortcut } from "@renderer/lib/platform";
import { Files, Search, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceTabsAtom,
} from "./workspace-state";

/** Uncommitted files listed on the page; the Changes tab holds the complete list. */
const RECENT_CHANGE_LIMIT = 8;
/** File search results shown at once; the project search already ranks the best matches first. */
const SEARCH_RESULT_LIMIT = 12;

interface NewTabTool {
	key: string;
	icon: LucideIcon;
	label: string;
	shortcut?: string;
	count?: number;
	onSelect: () => void;
}

/** The right column's launcher: find a project file, open a tool, or jump to an uncommitted change. */
export function WorkspaceNewTab() {
	const { t } = useTranslation();
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const activeProject = useWorkspaceField(workspaceSelectionAtom, "activeProject");
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { openFeatureViewer } = useWorkspaceOwner(workspaceTabsAtom);
	const { review, files } = useReviewWorkspace();
	const { dockItems } = useSessionExtensionMeta(runtimeSessionRef);
	if (activeSessionRef === null) return null;

	const changedFiles = review.snapshot?.scopes.workspace.files ?? files.files;
	const changeCount = review.snapshot?.scopes.workspace.count ?? files.files.length;
	const tool = (id: FeaturePageId, extra: Partial<NewTabTool> = {}): NewTabTool => ({
		key: id,
		icon: featurePageIcons[id],
		label: t(featurePageTitleKeys[id]),
		onSelect: () => openFeatureViewer(id),
		...extra,
	});
	const tools: NewTabTool[] = [
		tool("changes", { count: changeCount, onSelect: () => workbenchPanel.openReview("workspace") }),
		tool("terminal", { shortcut: shortcut("`") }),
		{
			key: "tree",
			icon: Files,
			label: t("explorer.title"),
			shortcut: shortcut("Shift+E"),
			onSelect: () => workbenchPanel.openTree(),
		},
		tool("skills"),
		tool("pi-config"),
		...(runtimeSessionRef ? [tool("dock", { count: dockItems })] : []),
		tool("todo"),
		tool("questions"),
		tool("background-tasks"),
	];

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-5">
				<ProjectFileSearch cwd={activeSessionRef.cwd} projectName={activeProject?.name} />
				<NewTabSection title={t("reading.newTabTools")}>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1.5">
						{tools.map((item) => (
							<button
								key={item.key}
								type="button"
								onClick={item.onSelect}
								className="flex h-9 min-w-0 items-center gap-2.5 rounded-control border border-border-subtle px-2.5 text-left text-ui text-text-primary transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
							>
								<item.icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								{item.shortcut !== undefined ? (
									<kbd className="shrink-0 rounded-sm border border-border-subtle px-1.5 py-0.5 font-mono text-xs leading-none text-text-muted">
										{item.shortcut}
									</kbd>
								) : item.count !== undefined && item.count > 0 ? (
									<span className="shrink-0 text-xs tabular-nums text-text-muted">
										{formatFeatureCount(item.count)}
									</span>
								) : null}
							</button>
						))}
					</div>
				</NewTabSection>
				{(changedFiles.length > 0 || files.error !== null) && (
					<NewTabSection title={t("reading.newTabChanges", { count: changeCount })}>
						{files.error !== null ? (
							<p role="alert" className="px-2.5 text-xs text-danger">
								{files.error}
							</p>
						) : (
							<div className="flex flex-col gap-px">
								{changedFiles.slice(0, RECENT_CHANGE_LIMIT).map((file) => {
									const { directory, name } = splitChangedPath(file.path);
									return (
										<button
											key={file.path}
											type="button"
											onClick={() => workbenchPanel.openReview("workspace", { focusFile: file.path })}
											className="flex h-8 min-w-0 items-center gap-2.5 rounded-control px-2.5 text-left text-ui transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
										>
											<StatusBadge file={file} />
											<span className="shrink-0 truncate text-text-primary">{name}</span>
											<span className="min-w-0 flex-1 truncate text-xs text-text-muted">{directory}</span>
										</button>
									);
								})}
								{changedFiles.length > RECENT_CHANGE_LIMIT && (
									<button
										type="button"
										onClick={() => workbenchPanel.openReview("workspace")}
										className="flex h-7 items-center rounded-control px-2.5 text-left text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
									>
										{t("reading.newTabAllChanges", { count: changeCount })}
									</button>
								)}
							</div>
						)}
					</NewTabSection>
				)}
			</div>
		</div>
	);
}

function NewTabSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section aria-label={title} className="flex flex-col gap-2">
			<h2 className="px-1 text-xs font-medium text-text-muted">{title}</h2>
			{children}
		</section>
	);
}

type SearchResult = { cwd: string; query: string; files: readonly ProjectMentionItem[]; error: string | null };

/** Project-wide file search; results belong to the cwd and query that requested them. */
function ProjectFileSearch({ cwd, projectName }: { cwd: string; projectName: string | undefined }) {
	const { t } = useTranslation();
	const projectApi = useDomainApi("project");
	const { openViewer } = useWorkspaceOwner(workspaceTabsAtom);
	const [query, setQuery] = useState("");
	const [result, setResult] = useState<SearchResult | null>(null);
	const trimmed = query.trim();
	useEffect(() => {
		if (trimmed === "") return;
		let cancelled = false;
		// Coalesce keystrokes; a late response for another query or project never replaces the current one.
		const timer = window.setTimeout(() => {
			void projectApi
				.listFiles({ cwd, query: trimmed })
				.then((files) => {
					if (!cancelled) setResult({ cwd, query: trimmed, files, error: null });
				})
				.catch((cause: unknown) => {
					if (!cancelled) setResult({ cwd, query: trimmed, files: [], error: formatRequestError(cause) });
				});
		}, 120);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [projectApi, cwd, trimmed]);
	const current = result?.cwd === cwd && result.query === trimmed ? result : null;
	const matches = (current?.files ?? []).filter((file) => file.kind === "file").slice(0, SEARCH_RESULT_LIMIT);
	const open = (path: string) => {
		openViewer(path);
		setQuery("");
	};
	return (
		<div className="flex flex-col gap-1">
			<div className="relative">
				<Search
					className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-muted"
					aria-hidden="true"
				/>
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && matches[0] !== undefined) open(matches[0].path);
						if (event.key === "Escape") setQuery("");
					}}
					aria-label={t("reading.newTabSearch", { project: projectName ?? cwd })}
					placeholder={t("reading.newTabSearch", { project: projectName ?? cwd })}
					className="h-9 pl-8"
				/>
			</div>
			{trimmed !== "" && (
				<section aria-label={t("reading.newTabSearchResults")} className="flex flex-col gap-px">
					{current === null ? (
						<p className="px-2.5 py-1.5 text-xs text-text-muted">…</p>
					) : current.error !== null ? (
						<p role="alert" className="px-2.5 py-1.5 text-xs text-danger">
							{current.error}
						</p>
					) : matches.length === 0 ? (
						<p className="px-2.5 py-1.5 text-xs text-text-muted">{t("reading.newTabNoMatch")}</p>
					) : (
						matches.map((file) => {
							const { directory, name } = splitChangedPath(file.path);
							return (
								<button
									key={file.path}
									type="button"
									onClick={() => open(file.path)}
									className="flex h-8 min-w-0 items-center gap-2.5 rounded-control px-2.5 text-left text-ui transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
								>
									<MaterialFileIcon path={file.path} className="size-3.5 shrink-0" />
									<span className="shrink-0 truncate text-text-primary">{name}</span>
									<span className="min-w-0 flex-1 truncate text-xs text-text-muted">{directory}</span>
								</button>
							);
						})
					)}
				</section>
			)}
		</div>
	);
}
