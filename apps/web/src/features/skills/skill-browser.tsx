import type { SkillInfo } from "@ling/contracts/skill";
import { Input } from "@renderer/components/ui/input";
import { SettingsState } from "@renderer/components/ui/settings-state";
import { tildify, basenameFromPath } from "@renderer/lib/format-path";
import { isWindows } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { ChevronDown, Folder, FolderOpen, GitBranch, GraduationCap, Package, Search, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type SkillRowToggle, SkillRows } from "./skill-list";

export interface SkillBrowserGroup {
	key: string;
	title: string;
	skills: readonly SkillInfo[];
	emptyTitle?: string;
	emptyDescription?: string;
	/** Rendered in the group header next to the count (e.g. the built-in master switch). */
	action?: ReactNode;
	/** Force-disable this group's row switches (built-in master switched off). */
	togglesDisabled?: boolean;
	/** Render rows directly without the directory-root chrome — for groups whose
	 * location is an implementation detail (built-in skills ship inside the app). */
	flat?: boolean;
}

interface SkillBrowserProps {
	groups: readonly SkillBrowserGroup[];
	/** Known discovery roots make nested collection folders readable without exposing a full absolute tree. */
	roots?: readonly string[];
	onSelect: (skill: SkillInfo) => void;
	/** Right-click action offered on every row; omitted where there is no composer to write into. */
	onUse?: (skill: SkillInfo) => void;
	/** Per-row load switches; omitted for read-only browsers (project dialog). */
	toggle?: Omit<SkillRowToggle, "disabled">;
	contained?: boolean;
	className?: string;
}

interface SkillFolder {
	key: string;
	label: string;
	skills: SkillInfo[];
}

/**
 * How a bucket earned its identity. `repo` and `package` name something the skill genuinely
 * belongs to; `directory` is the fallback for a skill nothing claims, and is the only kind whose
 * label is a path — a directory is a location, never a statement of ownership.
 */
type SkillBucketKind = "repo" | "package" | "directory";

interface SkillRoot {
	key: string;
	kind: SkillBucketKind;
	path: string;
	label: string;
	directSkills: SkillInfo[];
	folders: SkillFolder[];
	count: number;
}

interface ResolvedRoot {
	key: string;
	path: string;
}

function normalizePath(path: string): string {
	const separated = isWindows ? path.replaceAll("\\", "/") : path;
	if (separated === "/" || (isWindows && /^[a-z]:\/$/iu.test(separated))) return separated;
	return separated.replace(/\/+$/, "");
}

function comparisonPath(path: string): string {
	const normalized = normalizePath(path);
	return isWindows ? normalized.toLocaleLowerCase() : normalized;
}

function isWithinPath(path: string, root: string): boolean {
	const candidate = comparisonPath(path);
	const boundary = comparisonPath(root);
	return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

function relativePath(path: string, root: string): string | null {
	if (!isWithinPath(path, root)) return null;
	const candidate = normalizePath(path);
	const boundary = normalizePath(root);
	if (candidate.length === boundary.length) return "";
	return candidate.slice(boundary.length + 1);
}

function dirname(path: string): string {
	const normalized = normalizePath(path);
	const index = normalized.lastIndexOf("/");
	if (index < 0) return "";
	if (index === 0) return "/";
	if (isWindows && index === 2 && /^[a-z]:\//iu.test(normalized)) return normalized.slice(0, 3);
	return normalized.slice(0, index);
}

function explicitRoot(filePath: string, roots: readonly string[]): ResolvedRoot | null {
	const matches = roots.filter((root) => root.length > 0 && isWithinPath(filePath, root));
	if (matches.length === 0) return null;
	matches.sort((left, right) => normalizePath(right).length - normalizePath(left).length);
	const path = normalizePath(matches[0] ?? "");
	return { key: comparisonPath(path), path };
}

/** Find the meaningful skills root, preferring conventional agent directories over a nested collection's own `skills`. */
function inferredRoot(filePath: string): ResolvedRoot {
	const normalized = normalizePath(filePath);
	const segments = normalized.split("/");
	const isDirectorySkill = (segments.at(-1) ?? "").toLocaleLowerCase() === "skill.md";
	const itemDirectoryIndex = isDirectorySkill ? segments.length - 2 : segments.length - 1;
	const lastRootIndex = itemDirectoryIndex - 1;
	const candidates: number[] = [];
	let conventional: number | null = null;
	for (let index = 0; index <= lastRootIndex; index += 1) {
		if ((segments[index] ?? "").toLocaleLowerCase() !== "skills") continue;
		candidates.push(index);
		const parent = (segments[index - 1] ?? "").toLocaleLowerCase();
		if ([".agents", ".claude", ".codex", ".cursor", "agent"].includes(parent) && conventional === null) {
			conventional = index;
		}
	}
	const rootIndex = conventional ?? candidates.at(-1) ?? lastRootIndex;
	const normalizedRoot = segments.slice(0, rootIndex + 1).join("/") || "/";
	return { key: comparisonPath(normalizedRoot), path: normalizedRoot };
}

function itemParentPath(skill: SkillInfo): string {
	return basenameFromPath(skill.filePath).toLocaleLowerCase() === "skill.md"
		? dirname(dirname(skill.filePath))
		: dirname(skill.filePath);
}

function rootLabel(root: string, skills: readonly SkillInfo[]): string {
	const projectCwd = skills.find((skill) => skill.projectCwd !== null)?.projectCwd;
	if (projectCwd !== null && projectCwd !== undefined) {
		const relative = relativePath(root, projectCwd);
		if (relative !== null && relative.length > 0) return relative;
	}
	return tildify(root);
}

function folderLabel(path: string): string {
	return path.split("/").filter(Boolean).join(" / ");
}

/**
 * Buckets a group's skills by where they came from, falling back to the directory tree only for
 * skills whose origin nothing records. A source repository or a package splits a long list the way
 * a user thinks about it; the directory almost never does, because everything an installer put in
 * place shares one directory.
 */
function bucketOf(skill: SkillInfo): { key: string; label: string; kind: SkillBucketKind } | null {
	if (skill.provenance) {
		return { key: `repo:${skill.provenance.source}`, label: skill.provenance.source, kind: "repo" };
	}
	if (skill.origin === "package" && skill.source.length > 0) {
		return { key: `package:${skill.source}`, label: skill.source, kind: "package" };
	}
	return null;
}

function buildRoots(skills: readonly SkillInfo[], knownRoots: readonly string[]): SkillRoot[] {
	const roots = new Map<
		string,
		{
			kind: SkillBucketKind;
			path: string;
			label: string | null;
			directSkills: SkillInfo[];
			folders: Map<string, { label: string; skills: SkillInfo[] }>;
		}
	>();

	for (const skill of skills) {
		const bucket = bucketOf(skill);
		const resolved = bucket ?? explicitRoot(skill.filePath, knownRoots) ?? inferredRoot(skill.filePath);
		const path = "path" in resolved ? resolved.path : itemParentPath(skill);
		let root = roots.get(resolved.key);
		if (root === undefined) {
			root = {
				kind: bucket?.kind ?? "directory",
				path,
				label: bucket?.label ?? null,
				directSkills: [],
				folders: new Map(),
			};
			roots.set(resolved.key, root);
		}
		// A named bucket has no meaningful sub-tree: its members are one collection, however
		// the installer happened to lay them out on disk.
		const relativeFolder = bucket ? null : relativePath(itemParentPath(skill), path);
		if (relativeFolder === null || relativeFolder.length === 0) {
			root.directSkills.push(skill);
			continue;
		}
		const folderKey = comparisonPath(relativeFolder);
		const folder = root.folders.get(folderKey);
		if (folder === undefined) {
			root.folders.set(folderKey, { label: folderLabel(relativeFolder), skills: [skill] });
		} else {
			folder.skills.push(skill);
		}
	}

	return [...roots.entries()]
		.map(([key, root]) => {
			const sortSkills = (items: SkillInfo[]) => items.sort((a, b) => a.name.localeCompare(b.name));
			const folders = [...root.folders.entries()]
				.map(([folderKey, folder]) => ({ key: folderKey, label: folder.label, skills: sortSkills(folder.skills) }))
				.sort((a, b) => a.label.localeCompare(b.label));
			const directSkills = sortSkills(root.directSkills);
			return {
				key,
				kind: root.kind,
				path: root.path,
				label: root.label ?? rootLabel(root.path, skills),
				directSkills,
				folders,
				count: directSkills.length + folders.reduce((total, folder) => total + folder.skills.length, 0),
			};
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

function toggleKey(current: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(current);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

function matchesSearch(skill: SkillInfo, query: string): boolean {
	const haystack =
		`${skill.name}\n${skill.description}\n${skill.filePath}\n${skill.source}\n${skill.provenance?.source ?? ""}`.toLocaleLowerCase();
	return haystack.includes(query);
}

export function SkillBrowser({
	groups,
	roots = [],
	onSelect,
	onUse,
	toggle,
	contained = false,
	className,
}: SkillBrowserProps) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	// Only explicit clicks land here; the default follows the bucket count, so a group that
	// splits into several collections opens as a short index instead of one long wall of rows.
	const [rootOverrides, setRootOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(() => new Set());
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const searching = normalizedQuery.length > 0;
	const totalCount = groups.reduce((total, group) => total + group.skills.length, 0);
	const filteredGroups = useMemo(
		() =>
			groups.map((group) => ({
				...group,
				skills: searching ? group.skills.filter((skill) => matchesSearch(skill, normalizedQuery)) : group.skills,
			})),
		[groups, normalizedQuery, searching],
	);
	const visibleCount = filteredGroups.reduce((total, group) => total + group.skills.length, 0);

	return (
		<div className={cn("flex min-h-0 flex-col gap-3", className)}>
			<div className="flex shrink-0 flex-wrap items-center gap-2.5">
				<div className="relative min-w-[13rem] flex-1">
					<Search
						className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-text-muted"
						aria-hidden="true"
					/>
					<Input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("skills.searchPlaceholder")}
						aria-label={t("skills.searchLabel")}
						className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
					/>
					{query.length > 0 && (
						<button
							type="button"
							onClick={() => setQuery("")}
							aria-label={t("skills.clearSearch")}
							className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary"
						>
							<X className="size-3.5" aria-hidden="true" />
						</button>
					)}
				</div>
				<span className="ml-auto shrink-0 text-xs tabular-nums text-text-muted">
					{t("skills.searchResults", { visible: visibleCount, total: totalCount, count: totalCount })}
				</span>
			</div>

			<div className={cn("flex flex-col gap-5", contained && "min-h-0 flex-1 overflow-y-auto pr-1")}>
				{searching && visibleCount === 0 ? (
					<SettingsState
						icon={Search}
						title={t("skills.noSearchResults")}
						description={t("skills.noSearchResultsDescription")}
						compact
					/>
				) : (
					filteredGroups.map((group) => {
						if (group.skills.length === 0 && (searching || group.emptyTitle === undefined)) return null;
						const skillRoots = group.flat ? [] : buildRoots(group.skills, roots);
						const groupToggle: SkillRowToggle | undefined = toggle
							? { ...toggle, ...(group.togglesDisabled === undefined ? {} : { disabled: group.togglesDisabled }) }
							: undefined;
						return (
							<section key={group.key} className="flex flex-col gap-2">
								<div className="flex items-center justify-between gap-3 px-1">
									<h3 className="text-sm font-semibold text-text-primary">{group.title}</h3>
									<div className="flex items-center gap-3">
										{group.skills.length > 0 && (
											<span className="text-xs tabular-nums text-text-muted">
												{t("skills.folderCount", { count: group.skills.length })}
											</span>
										)}
										{group.action}
									</div>
								</div>
								{group.skills.length === 0 ? (
									<SettingsState
										icon={GraduationCap}
										title={group.emptyTitle ?? ""}
										{...(group.emptyDescription === undefined ? {} : { description: group.emptyDescription })}
										compact
									/>
								) : group.flat ? (
									<div className="divide-y divide-border-subtle overflow-hidden rounded-panel border border-border-subtle bg-surface">
										<SkillRows
											skills={[...group.skills].sort((a, b) => a.name.localeCompare(b.name))}
											onSelect={onSelect}
											{...(onUse === undefined ? {} : { onUse })}
											embedded
											compact
											{...(groupToggle === undefined ? {} : { toggle: groupToggle })}
										/>
									</div>
								) : (
									<div className="divide-y divide-border-subtle overflow-hidden rounded-panel border border-border-subtle bg-surface">
										{skillRoots.map((root) => {
											const rootKey = `${group.key}:${root.key}`;
											const resolvedOpen = rootOverrides.get(rootKey) ?? skillRoots.length <= 1;
											const rootOpen = searching || resolvedOpen;
											const RootIcon =
												root.kind === "repo"
													? GitBranch
													: root.kind === "package"
														? Package
														: rootOpen
															? FolderOpen
															: Folder;
											return (
												<div key={root.key}>
													<button
														type="button"
														aria-expanded={rootOpen}
														onClick={() => setRootOverrides((current) => new Map(current).set(rootKey, !resolvedOpen))}
														title={root.kind === "directory" ? tildify(root.path) : root.label}
														className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover/50 focus-visible:bg-surface-hover/50"
													>
														<ChevronDown
															className={cn(
																"size-3.5 shrink-0 text-text-muted transition-transform motion-reduce:transition-none",
																!rootOpen && "-rotate-90",
															)}
															aria-hidden="true"
														/>
														<RootIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
														<code className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
															{root.label}
														</code>
														<span className="shrink-0 text-xs tabular-nums text-text-muted">{root.count}</span>
													</button>
													{rootOpen && (
														<div className="border-border-subtle border-t bg-surface-raised/15">
															{root.directSkills.length > 0 && (
																<div className="divide-y divide-border-subtle">
																	<SkillRows
																		skills={root.directSkills}
																		onSelect={onSelect}
																		{...(onUse === undefined ? {} : { onUse })}
																		embedded
																		compact
																		rowClassName="pl-9"
																		{...(groupToggle === undefined ? {} : { toggle: groupToggle })}
																	/>
																</div>
															)}
															{root.folders.map((folder) => {
																const folderKey = `${rootKey}:${folder.key}`;
																const folderOpen = searching || expandedFolders.has(folderKey);
																return (
																	<div key={folder.key} className="border-border-subtle border-t first:border-t-0">
																		<button
																			type="button"
																			aria-expanded={folderOpen}
																			onClick={() => setExpandedFolders((current) => toggleKey(current, folderKey))}
																			className="flex w-full items-center gap-2.5 py-2.5 pr-3 pl-8 text-left transition-colors hover:bg-surface-hover/50 focus-visible:bg-surface-hover/50"
																		>
																			<ChevronDown
																				className={cn(
																					"size-3.5 shrink-0 text-text-muted transition-transform motion-reduce:transition-none",
																					!folderOpen && "-rotate-90",
																				)}
																				aria-hidden="true"
																			/>
																			{folderOpen ? (
																				<FolderOpen className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
																			) : (
																				<Folder className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
																			)}
																			<span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
																				{folder.label}
																			</span>
																			<span className="shrink-0 text-xs tabular-nums text-text-muted">
																				{folder.skills.length}
																			</span>
																		</button>
																		{folderOpen && (
																			<div className="divide-y divide-border-subtle border-border-subtle border-t bg-surface">
																				<SkillRows
																					skills={folder.skills}
																					onSelect={onSelect}
																					{...(onUse === undefined ? {} : { onUse })}
																					embedded
																					compact
																					rowClassName="pl-11"
																					{...(groupToggle === undefined ? {} : { toggle: groupToggle })}
																				/>
																			</div>
																		)}
																	</div>
																);
															})}
														</div>
													)}
												</div>
											);
										})}
									</div>
								)}
							</section>
						);
					})
				)}
			</div>
		</div>
	);
}
