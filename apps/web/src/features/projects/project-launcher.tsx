import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ProjectLaunchPreferences, ProjectLaunchTarget, ProjectLaunchTargetKind } from "@ling/contracts/project";
import { ProviderGlyph } from "@renderer/features/models/provider-glyph";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { noDragRegionClassName } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { Braces, Check, ChevronDown, Code2, FolderOpen, Terminal } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

interface ProjectLauncherProps {
	cwd: string;
	compact?: boolean;
	projectName?: string | undefined;
	onError: (error: unknown) => void;
}

/** Launch target group display order: file manager → editor → terminal. */
const TARGET_KIND_ORDER: readonly ProjectLaunchTargetKind[] = ["file-manager", "editor", "terminal"];
/** Target kind → i18n group title key. */
const TARGET_KIND_LABEL_KEYS: Record<ProjectLaunchTargetKind, string> = {
	"file-manager": "project.launcherFileManagers",
	editor: "project.launcherEditors",
	terminal: "project.launcherTerminals",
};

function TargetIcon({ target }: { target: Pick<ProjectLaunchTarget, "id" | "kind"> }) {
	if (target.id === "cursor") return <ProviderGlyph provider="cursor" size={16} />;
	if (target.id === "visual-studio-code") return <Code2 className="size-4" aria-hidden="true" />;
	if (target.kind === "editor") return <Braces className="size-4" aria-hidden="true" />;
	if (target.kind === "terminal") return <Terminal className="size-4" aria-hidden="true" />;
	return <FolderOpen className="size-4" aria-hidden="true" />;
}

export function ProjectLauncher({ cwd, projectName, onError, compact = false }: ProjectLauncherProps) {
	const hostProjectApi = useDomainApi("project");
	const hostAppApi = useDomainApi("app");

	const { t } = useTranslation();
	const [targets, setTargets] = useState<ProjectLaunchTarget[]>([]);
	const [preferences, setPreferences] = useState<ProjectLaunchPreferences | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const requestVersion = useRef(0);
	const fallbackTarget = useMemo<ProjectLaunchTarget>(
		() => ({ id: "visual-studio-code", kind: "editor", name: t("project.editor") }),
		[t],
	);
	const automaticEditor = targets.find((target) => target.kind === "editor");
	const configuredEditor =
		preferences?.editor === null || preferences?.editor === undefined
			? automaticEditor
			: targets.find((target) => target.id === preferences.editor);
	const activeTarget =
		configuredEditor ??
		(preferences?.editor
			? {
					id: preferences.editor,
					kind: "editor" as const,
					name: t("project.launcherUnavailable", { id: preferences.editor }),
				}
			: (automaticEditor ?? fallbackTarget));
	const groupedTargets = useMemo(
		() =>
			TARGET_KIND_ORDER.map((kind) => ({
				kind,
				targets: targets.filter((target) => target.kind === kind),
			})).filter((group) => group.targets.length > 0),
		[targets],
	);

	const refreshTargets = useCallback(() => {
		const version = ++requestVersion.current;
		void Promise.all([hostProjectApi.listLaunchTargets(), hostAppApi.getSettings()])
			.then(([nextTargets, settingsResult]) => {
				if (requestVersion.current !== version) return;
				setTargets(nextTargets);
				if (settingsResult.status === "ready") setPreferences(settingsResult.settings.projectLaunchers);
			})
			.catch(onError);
	}, [hostProjectApi, hostAppApi, onError]);

	useEffect(() => {
		refreshTargets();
		return () => {
			requestVersion.current += 1;
		};
	}, [refreshTargets]);

	const closeMenuBeforeLaunch = useCallback(() => {
		// External applications can take focus before React flushes a batched
		// state update. Commit the close first so the portal cannot remain
		// mounted in Ling's background accessibility tree.
		flushSync(() => setMenuOpen(false));
	}, []);

	const launchDefaultEditor = useCallback(() => {
		closeMenuBeforeLaunch();
		void hostProjectApi.launchDefault({ cwd, kind: "editor" }).catch(onError);
	}, [hostProjectApi, closeMenuBeforeLaunch, cwd, onError]);

	const chooseAndLaunch = (target: ProjectLaunchTarget) => {
		closeMenuBeforeLaunch();
		void hostAppApi
			.updateSettings({ type: "projectLauncher", kind: target.kind, targetId: target.id })
			.then((settings) => {
				setPreferences(settings.projectLaunchers);
				return hostProjectApi.launch({ cwd, targetId: target.id });
			})
			.catch(onError);
	};

	const launchLabel = t("project.launchWith", { name: activeTarget.name });
	return (
		<div
			data-project-launcher=""
			className={cn(
				"flex min-w-0 shrink-0 items-stretch rounded-control text-ui text-text-muted",
				compact ? "h-7 border border-border-subtle" : "workspace-tool-card min-h-12 w-full",
				noDragRegionClassName,
				menuOpen && "bg-surface-hover text-text-primary",
			)}
		>
			<button
				type="button"
				onClick={launchDefaultEditor}
				aria-label={launchLabel}
				className={cn(
					"flex min-w-0 flex-1 cursor-default items-center rounded-control text-start hover:bg-surface-hover focus-visible:bg-surface-hover",
					compact ? "gap-1.5 px-2 text-xs" : "gap-3 py-3 pl-3.5 pr-1",
				)}
			>
				<span className="shrink-0">
					<TargetIcon target={activeTarget} />
				</span>
				<span className="min-w-0 flex-1 break-words text-text-primary">
					{compact ? t("reading.openProject") : launchLabel}
				</span>
			</button>
			<DropdownMenu
				open={menuOpen}
				onOpenChange={(open) => {
					setMenuOpen(open);
					if (open) refreshTargets();
				}}
			>
				<DropdownMenuTrigger
					render={
						<button
							type="button"
							aria-label={t("project.chooseLauncher")}
							className="group flex w-8 shrink-0 cursor-default items-center justify-center rounded-control transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary data-[state=open]:bg-surface-hover data-[state=open]:text-text-primary motion-reduce:transition-none"
						/>
					}
				>
					<ChevronDown
						className="size-3.5 transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-180"
						aria-hidden="true"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-64 p-1.5" onCloseAutoFocus={(event) => event.preventDefault()}>
					<div className="px-2 pb-1.5 pt-1">
						<p className="text-xs font-medium text-text-primary">{t("project.openWith")}</p>
						{projectName && (
							<p className="mt-0.5 truncate text-xs text-text-muted" title={cwd}>
								{projectName}
							</p>
						)}
					</div>
					<DropdownMenuSeparator className="mx-0" />
					{groupedTargets.map((group, groupIndex) => (
						<Fragment key={group.kind}>
							{groupIndex > 0 && <DropdownMenuSeparator className="mx-0" />}
							<DropdownMenuLabel>{t(TARGET_KIND_LABEL_KEYS[group.kind])}</DropdownMenuLabel>
							{group.targets.map((target) => {
								const configured = preferences?.[group.kind] ?? null;
								const selected =
									configured === target.id || (configured === null && group.targets[0]?.id === target.id);
								return (
									<DropdownMenuItem
										key={target.id}
										onSelect={() => chooseAndLaunch(target)}
										className={cn("py-2", selected && "bg-surface-hover")}
									>
										<span className="flex size-6 shrink-0 items-center justify-center rounded-control bg-surface-hover text-text-muted">
											<TargetIcon target={target} />
										</span>
										<span className="min-w-0 flex-1 truncate">{target.name}</span>
										{selected && (
											<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-text-primary text-surface">
												<Check className="size-3" aria-hidden="true" />
											</span>
										)}
									</DropdownMenuItem>
								);
							})}
						</Fragment>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
