import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { appPlatform } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { Check, ChevronDown, ChevronUp, Columns2, Plus, Rows2, Search, SquareTerminal, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { findTerminalPane, terminalPaneLeaves } from "./terminal-layout";
import { TerminalLayout } from "./terminal-pane";
import type { TerminalController } from "./use-terminal-controller";

interface TerminalPanelProps {
	cwd: string;
	open: boolean;
	controller: TerminalController;
	onOpenChange: (open: boolean) => void;
	onError: (error: unknown) => void;
}

export function TerminalPanel({ cwd, open, controller, onOpenChange, onError }: TerminalPanelProps) {
	const { t } = useTranslation();
	const [creating, setCreating] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const searchedTerminalIdRef = useRef<string | null>(null);
	const { loading, ensureProjectTerminal, clearTerminalSearch, searchTerminal } = controller;
	const workspace = controller.getWorkspace(cwd);
	const activeLeaf =
		workspace?.root && workspace.activePaneId ? findTerminalPane(workspace.root, workspace.activePaneId) : null;
	const activeTerminalId = activeLeaf?.terminalId ?? workspace?.terminalIds[0] ?? null;

	useEffect(() => {
		if (!open || loading) return;
		let cancelled = false;
		setCreating(true);
		void ensureProjectTerminal(cwd)
			.catch((error: unknown) => {
				if (!cancelled) onError(error);
			})
			.finally(() => {
				if (!cancelled) setCreating(false);
			});
		return () => {
			cancelled = true;
		};
	}, [ensureProjectTerminal, loading, cwd, onError, open]);

	useEffect(() => {
		if (searchOpen) searchRef.current?.focus();
	}, [searchOpen]);

	useEffect(() => {
		const previous = searchedTerminalIdRef.current;
		if (previous && (previous !== activeTerminalId || !open || !searchOpen || searchQuery.length === 0)) {
			clearTerminalSearch(previous);
			searchedTerminalIdRef.current = null;
		}
		if (!open || !searchOpen || !activeTerminalId || searchQuery.length === 0) return;
		searchTerminal(activeTerminalId, searchQuery, "next", true);
		searchedTerminalIdRef.current = activeTerminalId;
	}, [activeTerminalId, clearTerminalSearch, searchTerminal, open, searchOpen, searchQuery]);

	useEffect(
		() => () => {
			const terminalId = searchedTerminalIdRef.current;
			if (terminalId) clearTerminalSearch(terminalId);
		},
		[clearTerminalSearch],
	);

	useEffect(() => {
		if (!open) return undefined;
		const handleFindShortcut = (event: KeyboardEvent) => {
			const target = event.target;
			if (!(target instanceof Element) || !target.closest("[data-terminal-panel]")) return;
			const primaryModifier =
				appPlatform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey && !event.shiftKey;
			if (event.key.toLowerCase() !== "f" || !primaryModifier || event.altKey) return;
			event.preventDefault();
			setSearchOpen(true);
		};
		window.addEventListener("keydown", handleFindShortcut);
		return () => window.removeEventListener("keydown", handleFindShortcut);
	}, [open]);

	const create = (profileId?: string | null) => {
		setCreating(true);
		void controller
			.createTerminal(cwd, profileId)
			.catch(onError)
			.finally(() => setCreating(false));
	};

	const split = (direction: "horizontal" | "vertical") => {
		setCreating(true);
		void controller
			.splitTerminal(cwd, direction)
			.catch(onError)
			.finally(() => setCreating(false));
	};

	const runSearch = (previous: boolean) => {
		if (!activeTerminalId || searchQuery.length === 0) return;
		searchTerminal(activeTerminalId, searchQuery, previous ? "previous" : "next", false);
		searchedTerminalIdRef.current = activeTerminalId;
	};

	const closeSearch = () => {
		setSearchOpen(false);
		if (activeTerminalId) controller.focusTerminal(activeTerminalId);
	};

	const tabs = useMemo(
		() =>
			(workspace?.terminalIds ?? []).map((terminalId) => ({
				terminalId,
				runtime: controller.getRuntime(terminalId),
			})),
		[controller, workspace?.terminalIds],
	);
	const creationDisabled = creating || loading;
	const splitDisabled = creationDisabled || !controller.canSplit(cwd);

	if (!open) return null;
	return (
		<section
			// Bottom split of the stage sheet: a hairline, not a nested card.
			className="glass-surface view-fade-in relative flex h-full min-h-0 flex-1 flex-col overflow-hidden border-border-subtle border-t bg-workbench-surface"
			aria-label={t("terminal.title")}
			data-terminal-panel=""
		>
			<header className="flex h-9 shrink-0 items-center gap-1 border-border-subtle border-b bg-workbench-chrome px-1.5 text-xs">
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
					<AnimatePresence initial={false}>
						{tabs.map(({ terminalId, runtime }) => {
							if (!runtime) return null;
							const selected = terminalId === activeTerminalId;
							return (
								<motion.div
									key={terminalId}
									layout
									initial={{ opacity: 0, scale: 0.92 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.92 }}
									transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
									className={cn(
										"group flex h-7 max-w-52 shrink-0 items-center rounded-control text-xs transition-colors",
										selected ? "bg-surface-hover text-text-primary" : "text-text-muted hover:bg-surface-hover/70",
									)}
								>
									<button
										type="button"
										onClick={() => {
											controller.selectTerminal(cwd, terminalId);
											controller.focusTerminal(terminalId);
										}}
										className="flex h-full min-w-0 items-center gap-1.5 pl-2"
										title={runtime.title}
									>
										<SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
										<span className="truncate">{runtime.title}</span>
										{runtime.snapshot.status === "exited" && (
											<span className="size-1.5 shrink-0 rounded-full bg-text-muted/40" />
										)}
									</button>
									<button
										type="button"
										onClick={() => void controller.closeTerminal(terminalId).catch(onError)}
										aria-label={t("terminal.closeTerminal", { name: runtime.title })}
										className="mx-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm text-text-muted/60 opacity-0 transition-opacity hover:bg-surface-hover hover:text-text-primary group-hover:opacity-100 focus-visible:opacity-100"
									>
										<X className="size-3" aria-hidden="true" />
									</button>
								</motion.div>
							);
						})}
						{creating && <span className="px-2 text-xs text-text-muted">{t("terminal.starting")}</span>}
					</AnimatePresence>
				</div>
				<AnimatePresence initial={false}>
					{searchOpen && (
						<motion.div
							initial={{ opacity: 0, x: 8 }}
							animate={{ opacity: 1, x: 0 }}
							exit={{ opacity: 0, x: 8 }}
							transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
							className="flex h-7 items-center rounded-control border border-border-subtle bg-input"
						>
							<Search className="ml-2 size-3.5 text-text-muted" aria-hidden="true" />
							<input
								ref={searchRef}
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										closeSearch();
									} else if (event.key === "Enter") {
										runSearch(event.shiftKey);
									}
								}}
								placeholder={t("terminal.searchPlaceholder")}
								aria-label={t("terminal.search")}
								className="h-full w-36 bg-transparent px-1.5 text-xs text-text-primary outline-none placeholder:text-text-muted/60"
							/>
							<button
								type="button"
								onClick={() => runSearch(true)}
								aria-label={t("terminal.previousMatch")}
								className="flex size-6 items-center justify-center text-text-muted hover:text-text-primary"
							>
								<ChevronUp className="size-3" aria-hidden="true" />
							</button>
							<button
								type="button"
								onClick={() => runSearch(false)}
								aria-label={t("terminal.nextMatch")}
								className="flex size-6 items-center justify-center text-text-muted hover:text-text-primary"
							>
								<ChevronDown className="size-3" aria-hidden="true" />
							</button>
							<button
								type="button"
								onClick={closeSearch}
								aria-label={t("terminal.closeSearch")}
								className="flex size-6 items-center justify-center text-text-muted hover:text-text-primary"
							>
								<X className="size-3" aria-hidden="true" />
							</button>
						</motion.div>
					)}
				</AnimatePresence>
				<TooltipIconButton
					onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
					label={t("terminal.search")}
					className="size-7"
				>
					<Search className="size-3.5" aria-hidden="true" />
				</TooltipIconButton>
				<TooltipIconButton
					onClick={() => split("horizontal")}
					label={t("terminal.splitRight")}
					className="size-7"
					disabled={splitDisabled}
				>
					<Columns2 className="size-3.5" aria-hidden="true" />
				</TooltipIconButton>
				<TooltipIconButton
					onClick={() => split("vertical")}
					label={t("terminal.splitDown")}
					className="size-7"
					disabled={splitDisabled}
				>
					<Rows2 className="size-3.5" aria-hidden="true" />
				</TooltipIconButton>
				<div className="flex h-7 items-stretch overflow-hidden rounded-control">
					<TooltipIconButton
						onClick={() => create()}
						label={t("terminal.newTerminal")}
						className="size-7 rounded-r-none"
						disabled={creationDisabled}
					>
						<Plus className="size-3.5" aria-hidden="true" />
					</TooltipIconButton>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<button
									type="button"
									aria-label={t("terminal.chooseProfile")}
									disabled={creationDisabled}
									className="flex w-6 items-center justify-center border-border-subtle border-l text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
								/>
							}
						>
							<ChevronDown className="size-3" aria-hidden="true" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-72" onCloseAutoFocus={(event) => event.preventDefault()}>
							<DropdownMenuLabel>{t("terminal.profiles")}</DropdownMenuLabel>
							<DropdownMenuSeparator />
							{controller.profiles.map((profile) => (
								<DropdownMenuItem key={profile.id} onSelect={() => create(profile.id)}>
									<SquareTerminal className="size-4" aria-hidden="true" />
									<span className="min-w-0 flex-1">
										<span className="block truncate">{profile.name}</span>
										<span className="block truncate text-xs text-text-muted">{profile.path}</span>
									</span>
									{profile.id === (controller.configuredProfileId ?? controller.suggestedProfileId) && (
										<Check className="size-3.5 text-text-muted" aria-hidden="true" />
									)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<TooltipIconButton onClick={() => onOpenChange(false)} label={t("terminal.closePanel")} className="size-7">
					<X className="size-3.5" aria-hidden="true" />
				</TooltipIconButton>
			</header>
			<div className="flex min-h-0 min-w-0 flex-1">
				{workspace?.root ? (
					<TerminalLayout
						cwd={cwd}
						node={workspace.root}
						activePaneId={workspace.activePaneId}
						controller={controller}
						showHeaders={terminalPaneLeaves(workspace.root).length > 1}
					/>
				) : (
					<div className="grid flex-1 place-items-center text-xs text-text-muted">
						{loading || creating ? t("terminal.starting") : t("terminal.empty")}
					</div>
				)}
			</div>
		</section>
	);
}
