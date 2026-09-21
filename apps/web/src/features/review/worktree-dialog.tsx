import { useDomainApi } from "@renderer/lib/host-api-context";
import type { WorktreeBranchOption } from "@ling/contracts/git";
import type { OpenProjectInfo } from "@ling/contracts/project";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { formatRequestError } from "@renderer/lib/errors";
import { tildify } from "@renderer/lib/format-path";
import { Check, ChevronDown, GitBranch, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface WorktreeDialogProps {
	project: OpenProjectInfo | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreate: (request: { rootCwd: string; path: string; branchName?: string; startPoint?: string }) => Promise<void>;
}

function rootWorkspace(project: OpenProjectInfo | null): string {
	if (!project) return "";
	return project.meta.kind === "worktree" && project.meta.rootWorkspacePath
		? project.meta.rootWorkspacePath
		: project.cwd;
}

function defaultWorktreePath(project: OpenProjectInfo | null, branchName: string): string {
	const root = rootWorkspace(project);
	const suffix = branchName.trim().replace(/[^\p{L}\p{N}_.-]+/gu, "-");
	return root && suffix ? `${root}-${suffix}` : "";
}

export function WorktreeDialog({ project, open, onOpenChange, onCreate }: WorktreeDialogProps) {
	const hostGitApi = useDomainApi("git");

	const { t } = useTranslation();
	const [branchName, setBranchName] = useState("");
	const [path, setPath] = useState("");
	const [startPoint, setStartPoint] = useState("");
	const [branches, setBranches] = useState<WorktreeBranchOption[]>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchesError, setBranchesError] = useState<string | null>(null);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [activeSuggestion, setActiveSuggestion] = useState(-1);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const loadRevisionRef = useRef(0);

	useEffect(() => {
		if (!open) return;
		setBranchName("");
		setPath("");
		setStartPoint("");
		setBranches([]);
		setBranchesError(null);
		setSuggestionsOpen(false);
		setActiveSuggestion(-1);
		setError(null);
		loadRevisionRef.current += 1;
		const revision = loadRevisionRef.current;
		const root = rootWorkspace(project);
		if (!root) return;
		setBranchesLoading(true);
		void hostGitApi
			.listWorktreeBranches(root)
			.then((items) => {
				if (revision === loadRevisionRef.current) setBranches(items);
			})
			.catch((cause: unknown) => {
				if (revision === loadRevisionRef.current) setBranchesError(formatRequestError(cause));
			})
			.finally(() => {
				if (revision === loadRevisionRef.current) setBranchesLoading(false);
			});
		return () => {
			loadRevisionRef.current += 1;
		};
	}, [hostGitApi, open, project]);

	const trimmedBranch = branchName.trim();
	const exactBranch = branches.find((branch) => branch.name === trimmedBranch);
	const occupiedPath = exactBranch?.checkedOutPath ?? null;
	const existingBranch = exactBranch !== undefined && occupiedPath === null;
	const filteredBranches = useMemo(() => {
		const query = trimmedBranch.toLocaleLowerCase();
		return branches.filter((branch) => !query || branch.name.toLocaleLowerCase().includes(query)).slice(0, 8);
	}, [branches, trimmedBranch]);
	const suggestionListVisible = suggestionsOpen && (branchesLoading || filteredBranches.length > 0);
	const effectivePath = useMemo(
		() => path.trim() || defaultWorktreePath(project, branchName),
		[path, project, branchName],
	);
	const canSubmit = Boolean(project && trimmedBranch && effectivePath && occupiedPath === null);
	const previewStart = startPoint.trim() || "HEAD";

	const chooseBranch = (branch: WorktreeBranchOption) => {
		if (branch.checkedOutPath !== null) return;
		setBranchName(branch.name);
		setStartPoint("");
		setSuggestionsOpen(false);
		setActiveSuggestion(-1);
	};

	const submit = async () => {
		if (!project || !canSubmit) return;
		setCreating(true);
		setError(null);
		try {
			await onCreate({
				rootCwd: rootWorkspace(project),
				path: effectivePath,
				...(existingBranch ? { startPoint: trimmedBranch } : { branchName: trimmedBranch }),
				...(!existingBranch && startPoint.trim() ? { startPoint: startPoint.trim() } : {}),
			});
			onOpenChange(false);
		} catch (createError) {
			setError(formatRequestError(createError));
		} finally {
			setCreating(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open && (
				<DialogContent>
					<div className="flex flex-col gap-4">
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2">
								<GitBranch className="size-4" aria-hidden="true" />
								{t("worktree.title")}
							</DialogTitle>
						</DialogHeader>

						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-1.5 text-xs text-text-muted">
								<label htmlFor="worktree-branch-name">{t("worktree.branch")}</label>
								<div className="relative">
									<Input
										id="worktree-branch-name"
										value={branchName}
										onFocus={() => setSuggestionsOpen(true)}
										onBlur={() => setSuggestionsOpen(false)}
										onChange={(event) => {
											setBranchName(event.target.value);
											setActiveSuggestion(-1);
											setSuggestionsOpen(true);
										}}
										onKeyDown={(event) => {
											if (event.key === "Escape") {
												setSuggestionsOpen(false);
												return;
											}
											if (event.key === "ArrowDown" || event.key === "ArrowUp") {
												event.preventDefault();
												setSuggestionsOpen(true);
												setActiveSuggestion((current) => {
													if (filteredBranches.length === 0) return -1;
													const delta = event.key === "ArrowDown" ? 1 : -1;
													return (current + delta + filteredBranches.length) % filteredBranches.length;
												});
												return;
											}
											if (event.key === "Enter" && activeSuggestion >= 0) {
												event.preventDefault();
												const branch = filteredBranches[activeSuggestion];
												if (branch) chooseBranch(branch);
											}
										}}
										placeholder={t("worktree.branchPlaceholder")}
										role="combobox"
										aria-autocomplete="list"
										aria-expanded={suggestionListVisible}
										aria-controls={suggestionListVisible ? "worktree-branch-options" : undefined}
										aria-activedescendant={
											suggestionListVisible && activeSuggestion >= 0
												? `worktree-branch-option-${activeSuggestion}`
												: undefined
										}
										aria-invalid={occupiedPath !== null}
									/>
									{suggestionListVisible && (
										<div
											id="worktree-branch-options"
											role="listbox"
											className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-control border border-border-subtle bg-popover py-1 shadow-lg"
										>
											{branchesLoading ? (
												<div className="flex min-h-9 items-center gap-2 px-3 text-xs text-text-muted">
													<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
													{t("worktree.loadingBranches")}
												</div>
											) : (
												filteredBranches.map((branch, index) => (
													<button
														id={`worktree-branch-option-${index}`}
														key={branch.name}
														type="button"
														role="option"
														aria-selected={branch.name === trimmedBranch}
														disabled={branch.checkedOutPath !== null}
														tabIndex={-1}
														onMouseDown={(event) => event.preventDefault()}
														onClick={() => chooseBranch(branch)}
														className={`flex min-h-9 w-full items-center gap-2 px-3 text-left text-xs ${
															index === activeSuggestion ? "bg-surface-hover text-text-primary" : "text-text-muted"
														} disabled:cursor-not-allowed disabled:opacity-55`}
													>
														<GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
														<span className="min-w-0 flex-1 truncate font-mono">{branch.name}</span>
														{branch.checkedOutPath ? (
															<span className="max-w-36 truncate text-xs" title={tildify(branch.checkedOutPath)}>
																{t("worktree.checkedOut")}
															</span>
														) : branch.name === trimmedBranch ? (
															<Check className="size-3.5 shrink-0" aria-hidden="true" />
														) : null}
													</button>
												))
											)}
										</div>
									)}
								</div>
							</div>
							{branchesError && <p className="text-xs text-warning">{branchesError}</p>}
							{occupiedPath && (
								<FeedbackNotice tone="warning" className="text-xs">
									{t("worktree.branchOccupied", { path: tildify(occupiedPath) })}
								</FeedbackNotice>
							)}
							{trimmedBranch && !exactBranch && (
								<div className="flex items-center gap-2 text-xs text-text-muted">
									<Plus className="size-3.5" aria-hidden="true" />
									{t("worktree.willCreateBranch", { branch: trimmedBranch })}
								</div>
							)}

							{trimmedBranch && (
								<dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control border border-border-subtle bg-surface-raised/40 px-3 py-2.5 text-xs">
									<dt className="text-text-muted">{t("worktree.previewAction")}</dt>
									<dd className="min-w-0 break-words text-text-primary">
										{t(existingBranch ? "worktree.useExistingBranch" : "worktree.createBranchFrom", {
											branch: trimmedBranch,
											startPoint: previewStart,
										})}
									</dd>
									<dt className="text-text-muted">{t("worktree.path")}</dt>
									<dd className="min-w-0 break-all font-mono text-xs text-text-muted">{effectivePath}</dd>
									<dt className="text-text-muted">{t("worktree.previewResult")}</dt>
									<dd className="text-text-muted">{t("worktree.previewResultDescription")}</dd>
								</dl>
							)}

							<details className="group rounded-control border border-border-subtle px-3 py-2">
								<summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 text-xs text-text-muted">
									<ChevronDown
										className="size-3.5 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none"
										aria-hidden="true"
									/>
									{t("worktree.advanced")}
								</summary>
								<div className="mt-3 flex flex-col gap-3">
									<label htmlFor="worktree-path" className="flex flex-col gap-1.5 text-xs text-text-muted">
										{t("worktree.path")}
										<Input
											id="worktree-path"
											value={path}
											onChange={(event) => setPath(event.target.value)}
											placeholder={defaultWorktreePath(project, branchName) || t("worktree.pathPlaceholder")}
										/>
									</label>
									<label htmlFor="worktree-start-point" className="flex flex-col gap-1.5 text-xs text-text-muted">
										{t("worktree.startPoint")}
										<Input
											id="worktree-start-point"
											value={existingBranch ? trimmedBranch : startPoint}
											disabled={existingBranch}
											onChange={(event) => setStartPoint(event.target.value)}
											placeholder={t("worktree.startPointPlaceholder")}
										/>
									</label>
								</div>
							</details>
						</div>

						{error && (
							<FeedbackNotice tone="danger" className="text-xs">
								{error}
							</FeedbackNotice>
						)}
						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
								{t("session.cancel")}
							</Button>
							<Button onClick={() => void submit()} disabled={!canSubmit || creating}>
								{creating ? t("worktree.creating") : t("worktree.create")}
							</Button>
						</DialogFooter>
					</div>
				</DialogContent>
			)}
		</Dialog>
	);
}
