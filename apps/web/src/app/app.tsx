import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { InteractionsProvider } from "@renderer/features/interactions/interactions-provider";
import { BuiltinFeaturesProvider } from "@renderer/features/companions/builtin-features";
import { AppNavigationContext, type AppNavigation } from "@renderer/lib/app-navigation";
import {
	draftsAtom,
	EMPTY_DRAFT,
	NEW_CONVERSATION_DRAFT_KEY,
	isEmptySessionDraft,
} from "@renderer/features/sessions/state/drafts";
import type { SessionRef } from "@ling/contracts/session-ref";
import { DataHealth } from "@renderer/components/data-health/data-health";
import { UserStateHealth } from "@renderer/components/data-health/user-state-health";
import { PanelBoundary } from "@renderer/components/error-fallback";
import { GlobalErrorListeners } from "@renderer/components/global-error-listeners";
import { AppFeedbackProvider } from "@renderer/components/ui/feedback";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ProjectPicker } from "@renderer/features/projects/project-picker";
import { ProjectTrustDialog } from "@renderer/features/projects/project-trust-dialog";
import { type ProjectController, useProjects } from "@renderer/features/projects/use-projects";
import { DraftPersistenceFeedback } from "@renderer/features/sessions/draft-persistence-feedback";
import { useSessions } from "@renderer/features/sessions/use-sessions";
import { CommandPalette } from "@renderer/features/workspace/command-palette";
import { useWorkspaceCleanup } from "@renderer/features/workspace/use-workspace-cleanup";
import { WorkspaceShell } from "@renderer/features/workspace/workspace-shell";
import { SkinBackdrop } from "@renderer/lib/appearance/skins/skin-backdrop";
import { SkinBackdropContext } from "@renderer/lib/appearance/skins/skin-backdrop-context";
import { SkinLoadingState } from "@renderer/lib/appearance/skins/skin-loading-state";
import { useSkin } from "@renderer/lib/appearance/use-skin";
import type { ThemeController } from "@renderer/lib/appearance/use-theme";
import { formatRequestError } from "@renderer/lib/errors";
import {
	appModeAtom,
	settingsCategoryAtom,
	appPageAtom,
	newConversationCwdAtom,
	composerFocusRequestIdAtom,
} from "@renderer/lib/navigation-state";
import { cn } from "@renderer/lib/utils";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const SettingsShell = lazy(() =>
	import("@renderer/features/settings/settings-shell").then(({ SettingsShell }) => ({ default: SettingsShell })),
);

/**
 * The session on screen, kept in sessionStorage so a renderer reload lands back on it. A
 * renderer crash makes Main reload the window (see main/index.ts render-process-gone), and
 * without this the reader finds the home view with their running session "gone". sessionStorage
 * is per window lifetime: it survives reloads but not an app relaunch, which keeps this
 * strictly a recovery path rather than a "reopen last session on launch" feature.
 */
const RELOAD_VIEWED_SESSION_KEY = "ling.reload.viewedSession";

function readReloadViewedSession(): SessionRef | null {
	const raw = sessionStorage.getItem(RELOAD_VIEWED_SESSION_KEY);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as SessionRef).cwd === "string" &&
			typeof (parsed as SessionRef).sessionId === "string"
		) {
			return { cwd: (parsed as SessionRef).cwd, sessionId: (parsed as SessionRef).sessionId };
		}
	} catch {
		// A corrupt value is just no recovery target.
	}
	return null;
}

function ReadyApp({
	projectController,
	themeController,
}: {
	projectController: ProjectController;
	themeController: ThemeController;
}) {
	const hostSessionApi = useDomainApi("session");
	const appApi = useDomainApi("app");

	const [mode, setMode] = useAtom(appModeAtom);
	const [appPage, setAppPage] = useAtom(appPageAtom);
	const setSettingsCategory = useSetAtom(settingsCategoryAtom);
	const store = useStore();
	const setNewConversationCwd = useSetAtom(newConversationCwdAtom);
	const requestComposerFocus = useSetAtom(composerFocusRequestIdAtom);
	const setDrafts = useSetAtom(draftsAtom);
	const cleanup = useWorkspaceCleanup();
	const sessionController = useSessions(cleanup);
	const { show: showFeedback } = useAppFeedback();
	const { t } = useTranslation();
	const viewedSessionRef = mode === "workspace" && !appPage ? sessionController.activeSessionRef : null;
	const { projects: openProjects } = projectController;
	const { refresh: refreshSessions } = sessionController;
	const knownProjectCwdsRef = useRef<Set<string> | null>(null);

	// Every in-workspace Add entry point updates the shared project controller. Refresh the
	// session catalog once that committed project set grows, so newly discoverable Pi history
	// reaches the sidebar regardless of whether Add came from the sidebar, palette, or composer.
	// The first run only records the baseline: useSessions already refreshes on mount.
	useEffect(() => {
		const known = knownProjectCwdsRef.current;
		knownProjectCwdsRef.current = new Set(openProjects.map((project) => project.cwd));
		if (known === null) return;
		if (openProjects.some((project) => !known.has(project.cwd))) void refreshSessions();
	}, [openProjects, refreshSessions]);

	// Notification routing follows what is actually on screen, not merely the last runtime
	// resumed in Main. Settings and the empty workspace therefore count as background views.
	useEffect(() => {
		void hostSessionApi.setViewedSession(viewedSessionRef).catch((error: unknown) => {
			showFeedback({
				tone: "danger",
				title: t("session.notificationRoutingFailed"),
				description: formatRequestError(error),
				dedupeKey: "session-view-notification-sync",
			});
		});
	}, [hostSessionApi, showFeedback, t, viewedSessionRef]);

	useEffect(
		() => () => {
			void hostSessionApi.setViewedSession(null).catch(() => undefined);
		},
		[hostSessionApi],
	);

	const selectSession = sessionController.selectSession;
	// Recovery after a renderer reload: reopen the session that was on screen. Read once on
	// mount, before the persist effect below observes the initial null and clears the key.
	useEffect(() => {
		const ref = readReloadViewedSession();
		if (ref === null) return;
		void selectSession(ref).catch((error: unknown) => {
			showFeedback({
				tone: "danger",
				title: t("session.restoreFailed"),
				description: formatRequestError(error),
				dedupeKey: "session-reload-restore",
			});
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: later selection changes are the user's, not a recovery
	}, []);
	useEffect(() => {
		if (sessionController.activeSessionRef)
			sessionStorage.setItem(RELOAD_VIEWED_SESSION_KEY, JSON.stringify(sessionController.activeSessionRef));
		else sessionStorage.removeItem(RELOAD_VIEWED_SESSION_KEY);
	}, [sessionController.activeSessionRef]);

	// Notification click: the main process asks to bring that session into view.
	useEffect(() => {
		return hostSessionApi.onActivateRequest((ref) => {
			setMode("workspace");
			setAppPage(null);
			void selectSession(ref).catch((error: unknown) => {
				showFeedback({
					tone: "danger",
					title: t("session.openFailed"),
					description: formatRequestError(error),
					dedupeKey: "session-notification-open",
				});
			});
		});
	}, [hostSessionApi, selectSession, setMode, setAppPage, showFeedback, t]);

	// Mount settings on its first visit, then preserve its controls and viewport on later switches.
	const [settingsVisited, setSettingsVisited] = useState(mode === "settings");
	useEffect(() => {
		if (mode === "settings") setSettingsVisited(true);
	}, [mode]);
	const palette = (
		<CommandPalette
			projectController={projectController}
			sessionController={sessionController}
			themeController={themeController}
		/>
	);

	const navigation = useMemo<AppNavigation>(
		() => ({
			async openSession(target) {
				if (
					!sessionController.sessions.some((session) => session.id === target.sessionId && session.cwd === target.cwd)
				)
					throw new Error(t("session.openFailed"));
				await selectSession(target);
				setAppPage(null);
				setMode("workspace");
			},
			compose(cwd, text) {
				if (!openProjects.some((project) => project.cwd === cwd && project.availability === "ready"))
					throw new Error(t("project.unavailable"));
				const draft = store.get(draftsAtom)[NEW_CONVERSATION_DRAFT_KEY];
				if (draft && !isEmptySessionDraft(draft) && draft.text !== text)
					throw new Error(t("session.quickStartDraftOccupied"));
				setDrafts((current) => ({
					...current,
					[NEW_CONVERSATION_DRAFT_KEY]: draft ?? { ...EMPTY_DRAFT, text },
				}));
				setNewConversationCwd(cwd);
				sessionController.deselectSession();
				requestComposerFocus((value) => value + 1);
				setAppPage(null);
				setMode("workspace");
			},
			openSettings(category) {
				setSettingsCategory(category);
				setMode("settings");
			},
			openPath: (path) => appApi.openPath(path),
		}),
		[
			appApi,
			openProjects,
			requestComposerFocus,
			selectSession,
			sessionController,
			setAppPage,
			setDrafts,
			setMode,
			setNewConversationCwd,
			setSettingsCategory,
			store,
			t,
		],
	);

	return (
		<AppNavigationContext value={navigation}>
			{/*
			 * Preserve both shells and their viewport geometry. display:none reports zero-sized
			 * transcript rows to the virtualizer and bottom follower, losing the reading position.
			 * Inert hidden shells cannot receive focus or expose off-screen controls.
			 */}
			<div
				className={cn("h-full w-full", mode !== "workspace" && "invisible absolute inset-0")}
				inert={mode !== "workspace"}
			>
				<PanelBoundary fallbackClassName="h-full w-full bg-surface-under">
					<WorkspaceShell
						projectController={projectController}
						sessionController={sessionController}
						onOpenSettings={() => setMode("settings")}
						visible={mode === "workspace"}
						overlay={mode === "workspace" ? palette : null}
					/>
				</PanelBoundary>
			</div>
			<div
				className={cn("h-full w-full", mode !== "settings" && "invisible absolute inset-0")}
				inert={mode !== "settings"}
			>
				<PanelBoundary fallbackClassName="h-full w-full bg-surface-under">
					<Suspense fallback={<SkinLoadingState label={t("settings.loading")} />}>
						{(settingsVisited || mode === "settings") && (
							<SettingsShell themeController={themeController} onBack={() => setMode("workspace")} />
						)}
					</Suspense>
				</PanelBoundary>
			</div>
			{mode === "settings" && palette}
		</AppNavigationContext>
	);
}

export function App() {
	const reducedMotion = useReducedMotion();
	const { t } = useTranslation();
	const cleanup = useWorkspaceCleanup();
	const projectController = useProjects(cleanup);
	const appMode = useAtomValue(appModeAtom);
	const skinBackdrop = useSkin(appMode === "workspace");
	const { themeController } = skinBackdrop;
	const restoringProjects = projectController.loading && projectController.projects.length === 0;

	// A file dropped outside a drop zone must not navigate the renderer to file://.
	// Zones call preventDefault themselves during bubbling, so this window-level guard
	// only changes what happens to strays (Chromium's default is full navigation).
	useEffect(() => {
		const preventNavigation = (event: globalThis.DragEvent) => event.preventDefault();
		window.addEventListener("dragover", preventNavigation);
		window.addEventListener("drop", preventNavigation);
		return () => {
			window.removeEventListener("dragover", preventNavigation);
			window.removeEventListener("drop", preventNavigation);
		};
	}, []);

	return (
		<MotionConfig reducedMotion={skinBackdrop.motion === "none" || reducedMotion ? "always" : "user"}>
			<TooltipProvider>
				<AppFeedbackProvider>
					<GlobalErrorListeners />
					<DataHealth />
					<UserStateHealth />
					<DraftPersistenceFeedback />

					<SkinBackdropContext value={skinBackdrop}>
						<BuiltinFeaturesProvider>
							<InteractionsProvider>
								{/* First in DOM: paints behind everything; alpha surface tokens reveal it. */}
								<SkinBackdrop
									layer={!restoringProjects && skinBackdrop.layer?.scope === "window" ? skinBackdrop.layer : null}
									motion={skinBackdrop.motion}
									className="fixed z-auto"
								/>
								{/* Gate on absent data, not on a request in flight: refresh() re-runs on a store
							    retry, and blanking here remounts the entire workspace. */}
								{restoringProjects ? (
									<SkinLoadingState label={t("common.loading")} />
								) : projectController.projects.length === 0 ? (
									<ProjectPicker
										storeError={projectController.storeRecoveryError}
										storePersistenceError={projectController.storePersistenceError}
										loadError={projectController.error}
										onRetryLoad={() => void projectController.retryProjectStore()}
										onAddProject={() => void projectController.addProject()}
									/>
								) : (
									<ReadyApp projectController={projectController} themeController={themeController} />
								)}
								{/* Startup restore can block on trust before project:list resolves, so this
						    bridge must remain mounted in loading, picker, and workspace states. */}
								<ProjectTrustDialog />
							</InteractionsProvider>
						</BuiltinFeaturesProvider>
					</SkinBackdropContext>
				</AppFeedbackProvider>
			</TooltipProvider>
		</MotionConfig>
	);
}
