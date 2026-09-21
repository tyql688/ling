import { useDomainApi } from "@renderer/lib/host-api-context";
import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionSummary } from "@ling/contracts/session";
import { sameSessionRef, sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { sessionSeenAtAtom } from "@renderer/features/sessions/state/seen";
import { isImeCommandMenuKey, useImeGuard } from "@renderer/hooks/use-ime-guard";
import type { ThemeController } from "@renderer/lib/appearance/use-theme";
import { formatRequestError } from "@renderer/lib/errors";
import { basenameFromPath } from "@renderer/lib/format-path";
import { appModeAtom } from "@renderer/lib/navigation-state";
import { isShortcutModifier, shortcut } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { Command } from "cmdk";
import { useAtom, useAtomValue } from "jotai";
import {
	Archive,
	Circle,
	Code2,
	FolderOpen,
	MessageSquare,
	PanelLeft,
	Pin,
	Settings,
	SquarePen,
	SquareTerminal,
	SunMoon,
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectController } from "../projects/use-projects";
import type { SessionController } from "../sessions/use-sessions";

type PaletteGroup = "chats" | "unread" | "recommended" | "conversation" | "navigation";

interface PaletteItem {
	id: string;
	group: PaletteGroup;
	label: string;
	icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
	run: () => unknown;
	meta?: string;
	shortcut?: string;
	searchText?: string;
}

interface PaletteGroupModel {
	id: PaletteGroup;
	heading: string;
	items: PaletteItem[];
}

interface CommandPaletteProps {
	projectController: ProjectController;
	sessionController: SessionController;
	themeController: ThemeController;
}

/** Order ring for the command palette's "cycle theme" action. */
const THEME_CYCLE: Array<"system" | "light" | "dark"> = ["system", "light", "dark"];
/** Cap on in-palette session search results; 9 is enough to jump without drowning other commands. */
const MAX_CHAT_RESULTS = 9;

function normalized(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function paletteItemValue(item: PaletteItem): string {
	const parts = [item.label, item.id];
	if (item.meta) parts.push(item.meta);
	if (item.searchText) parts.push(item.searchText);
	return parts.join(" ");
}

function projectNameForSession(projectsByCwd: ReadonlyMap<string, OpenProjectInfo>, session: SessionSummary): string {
	const project = projectsByCwd.get(session.cwd);
	if (!project) return basenameFromPath(session.cwd);
	return project.name;
}

function comparePaletteSessions(left: SessionSummary, right: SessionSummary): number {
	if (left.pinnedAt !== undefined && right.pinnedAt === undefined) return -1;
	if (left.pinnedAt === undefined && right.pinnedAt !== undefined) return 1;
	if (left.archivedAt === undefined && right.archivedAt !== undefined) return -1;
	if (left.archivedAt !== undefined && right.archivedAt === undefined) return 1;
	return right.updatedAt - left.updatedAt;
}

function PaletteRow({ item, onSelect }: { item: PaletteItem; onSelect: () => void }) {
	const Icon = item.icon;
	return (
		<Command.Item
			value={paletteItemValue(item)}
			onSelect={onSelect}
			className="flex min-h-8 w-full cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm text-text-primary transition-colors data-[selected=true]:bg-surface-hover"
		>
			<Icon className="size-3.5 shrink-0 text-text-muted" aria-hidden={true} />
			<span className="min-w-0 flex-1 truncate">{item.label}</span>
			{item.meta && <span className="max-w-28 shrink-0 truncate text-xs text-text-muted">{item.meta}</span>}
			{item.shortcut && (
				<span className="shrink-0 rounded-control bg-surface-hover px-1.5 py-0.5 text-xs leading-none text-text-muted">
					{item.shortcut}
				</span>
			)}
		</Command.Item>
	);
}

/** Search and command surface: chat results stay grouped apart from real actions. */
export function CommandPalette({ projectController, sessionController, themeController }: CommandPaletteProps) {
	const hostProjectApi = useDomainApi("project");

	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useAtom(appModeAtom);
	const sessionSeenAt = useAtomValue(sessionSeenAtAtom);
	const { sessions, activeSessionRef, selectSession, deselectSession, setSessionPinned, setSessionArchived } =
		sessionController;
	const { projects, addProject } = projectController;
	const { preference, setPreference, switchable } = themeController;
	const inputRef = useRef<HTMLInputElement>(null);
	const ime = useImeGuard();

	useEffect(() => {
		function handleGlobalKeyDown(event: globalThis.KeyboardEvent) {
			if (isShortcutModifier(event) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setOpen((value) => !value);
			}
		}
		window.addEventListener("keydown", handleGlobalKeyDown);
		return () => window.removeEventListener("keydown", handleGlobalKeyDown);
	}, []);

	useEffect(() => {
		ime.resetComposition();
		if (open) {
			setQuery("");
			setError(null);
		}
	}, [ime, open]);

	const projectsByCwd = useMemo(() => new Map(projects.map((project) => [project.cwd, project])), [projects]);
	const activeSession = sessions.find((session) => sameSessionRef(toSessionRef(session), activeSessionRef));
	const searchQuery = normalized(query);

	const topLevelSessions = useMemo(
		() => sessions.filter((session) => session.relation?.kind !== "child").sort(comparePaletteSessions),
		[sessions],
	);

	const sessionMatchesQuery = useCallback(
		(session: SessionSummary) => {
			if (!searchQuery) return true;
			const projectName = projectNameForSession(projectsByCwd, session);
			return normalized(`${session.title} ${projectName} ${session.preview}`).includes(searchQuery);
		},
		[projectsByCwd, searchQuery],
	);

	const buildChatItem = useCallback(
		(session: SessionSummary, group: PaletteGroup, idPrefix: string, shortcutLabel: string | null): PaletteItem => {
			const projectName = projectNameForSession(projectsByCwd, session);
			const Icon = session.archivedAt === undefined ? Circle : Archive;
			const item: PaletteItem = {
				id: `${idPrefix}-${session.cwd}-${session.id}`,
				group,
				label: session.title,
				icon: Icon,
				meta: projectName,
				searchText: session.preview,
				run: () => {
					setMode("workspace");
					return selectSession(toSessionRef(session));
				},
			};
			if (shortcutLabel !== null) item.shortcut = shortcutLabel;
			return item;
		},
		[projectsByCwd, selectSession, setMode],
	);

	const chatItems = useMemo<PaletteItem[]>(
		() =>
			topLevelSessions
				.filter(sessionMatchesQuery)
				.slice(0, MAX_CHAT_RESULTS)
				.map((session, index) => buildChatItem(session, "chats", "chat", shortcut(String(index + 1)))),
		[buildChatItem, sessionMatchesQuery, topLevelSessions],
	);

	const unreadItems = useMemo<PaletteItem[]>(
		() =>
			topLevelSessions
				.filter((session) => {
					if (sameSessionRef(toSessionRef(session), activeSessionRef)) return false;
					const seenAt = sessionSeenAt[sessionKey(toSessionRef(session))];
					return seenAt !== undefined && session.updatedAt > seenAt;
				})
				.filter(sessionMatchesQuery)
				.slice(0, MAX_CHAT_RESULTS)
				.map((session) => buildChatItem(session, "unread", "unread-chat", null)),
		[activeSessionRef, buildChatItem, sessionMatchesQuery, sessionSeenAt, topLevelSessions],
	);

	const recommendedItems = useMemo<PaletteItem[]>(
		() => [
			{
				id: "new-chat",
				group: "recommended",
				label: t("palette.newChat"),
				icon: SquarePen,
				shortcut: shortcut("N"),
				run: () => {
					setMode("workspace");
					deselectSession();
				},
			},
			{
				id: "open-folder",
				group: "recommended",
				label: t("palette.openFolder"),
				icon: FolderOpen,
				run: addProject,
			},
			{
				id: "settings",
				group: "recommended",
				label: t("palette.openSettings"),
				icon: Settings,
				run: () => setMode("settings"),
			},
			...(switchable
				? [
						{
							id: "theme",
							group: "recommended" as const,
							label: t("palette.toggleTheme", { current: t(`settings.theme_${preference}`) }),
							icon: SunMoon,
							run: () => {
								const nextPreference = THEME_CYCLE[(THEME_CYCLE.indexOf(preference) + 1) % THEME_CYCLE.length];
								if (nextPreference === undefined) throw new Error("Invalid theme preference cycle");
								setPreference(nextPreference);
							},
						},
					]
				: []),
		],
		[addProject, deselectSession, preference, setMode, setPreference, switchable, t],
	);

	const conversationItems = useMemo<PaletteItem[]>(() => {
		if (!activeSession) return [];
		const ref = toSessionRef(activeSession);
		const projectName = projectNameForSession(projectsByCwd, activeSession);
		return [
			{
				id: "open-active-chat",
				group: "conversation",
				label: t("palette.openActiveChat"),
				icon: MessageSquare,
				meta: activeSession.title,
				run: () => {
					setMode("workspace");
					return selectSession(ref);
				},
			},
			{
				id: "toggle-active-pin",
				group: "conversation",
				label: t(activeSession.pinnedAt === undefined ? "palette.pinChat" : "palette.unpinChat"),
				icon: Pin,
				run: () => setSessionPinned(ref, activeSession.pinnedAt === undefined),
			},
			{
				id: "archive-active-chat",
				group: "conversation",
				label: t("palette.archiveChat"),
				icon: Archive,
				run: () => setSessionArchived(ref, true),
			},
			{
				id: "open-active-project-editor",
				group: "conversation",
				label: t("palette.openInEditor"),
				icon: Code2,
				meta: projectName,
				run: () => hostProjectApi.launchDefault({ cwd: activeSession.cwd, kind: "editor" }),
			},
			{
				id: "open-active-project-terminal",
				group: "conversation",
				label: t("palette.openInExternalTerminal"),
				icon: SquareTerminal,
				meta: projectName,
				run: () => hostProjectApi.launchDefault({ cwd: activeSession.cwd, kind: "terminal" }),
			},
			{
				id: "reveal-active-project",
				group: "conversation",
				label: t("palette.showInFinder"),
				icon: FolderOpen,
				meta: projectName,
				run: () => hostProjectApi.launchDefault({ cwd: activeSession.cwd, kind: "file-manager" }),
			},
		];
	}, [hostProjectApi, activeSession, projectsByCwd, selectSession, setMode, setSessionArchived, setSessionPinned, t]);

	const navigationItems = useMemo<PaletteItem[]>(() => {
		if (mode !== "settings") return [];
		return [
			{
				id: "back-to-workspace",
				group: "navigation",
				label: t("palette.backToWorkspace"),
				icon: PanelLeft,
				run: () => setMode("workspace"),
			},
		];
	}, [mode, setMode, t]);

	const groups = useMemo<PaletteGroupModel[]>(() => {
		const allGroups: PaletteGroupModel[] = [
			{ id: "chats", heading: t("palette.groupChats"), items: chatItems },
			{ id: "unread", heading: t("palette.groupUnread"), items: unreadItems },
			{ id: "recommended", heading: t("palette.groupRecommended"), items: recommendedItems },
			{ id: "conversation", heading: t("palette.groupConversation"), items: conversationItems },
			{ id: "navigation", heading: t("palette.groupNavigation"), items: navigationItems },
		];
		return allGroups.filter((group) => group.items.length > 0);
	}, [chatItems, conversationItems, navigationItems, recommendedItems, t, unreadItems]);

	const runItem = (item: PaletteItem) => {
		setError(null);
		try {
			const result = item.run();
			void Promise.resolve(result)
				.then(() => setOpen(false))
				.catch((cause) => setError(formatRequestError(cause, t)));
		} catch (cause) {
			setError(formatRequestError(cause, t));
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				ime.resetComposition();
				setOpen(next);
			}}
		>
			<DialogContent
				variant="center"
				size="medium"
				aria-describedby={undefined}
				className="top-24 translate-y-0 overflow-hidden p-2"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					inputRef.current?.focus();
				}}
				onEscapeKeyDown={(event) => {
					if (ime.isNativeComposing(event)) event.preventDefault();
				}}
			>
				<DialogTitle className="sr-only">{t("palette.placeholder")}</DialogTitle>
				<Command
					aria-label={t("palette.placeholder")}
					className="w-full"
					onKeyDown={(event) => {
						if (ime.isComposing(event)) {
							if (isImeCommandMenuKey(event)) {
								event.preventDefault();
								event.stopPropagation();
							}
							return;
						}
						if (isShortcutModifier(event) && /^[1-9]$/.test(event.key)) {
							const item = chatItems[Number.parseInt(event.key, 10) - 1];
							if (!item) return;
							event.preventDefault();
							event.stopPropagation();
							runItem(item);
						}
					}}
				>
					<Command.Input
						ref={inputRef}
						aria-label={t("palette.inputLabel")}
						value={query}
						onValueChange={setQuery}
						placeholder={t("palette.placeholder")}
						className="mb-1 w-full rounded-control border-b border-border-subtle bg-transparent px-3 py-3 text-sm text-text-primary placeholder:text-text-muted"
						{...ime.compositionProps}
					/>
					{error && (
						<div className="mx-2 mb-1">
							<FeedbackNotice tone="danger" className="rounded-control px-2 py-1.5 text-xs">
								{error}
							</FeedbackNotice>
						</div>
					)}
					<Command.List label={t("palette.suggestions")} className="max-h-[70vh] overflow-y-auto">
						<Command.Empty className="px-2 py-2 text-sm text-text-muted">{t("palette.noResults")}</Command.Empty>
						{groups.map((group) => (
							<Command.Group
								key={group.id}
								heading={group.heading}
								className={cn(
									"py-1",
									"[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1",
									"[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-text-muted",
								)}
							>
								{group.items.map((item) => (
									<PaletteRow key={item.id} item={item} onSelect={() => runItem(item)} />
								))}
							</Command.Group>
						))}
					</Command.List>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
