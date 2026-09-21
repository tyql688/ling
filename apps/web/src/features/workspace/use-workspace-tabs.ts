import { appPageAtom } from "@renderer/lib/navigation-state";
import { featurePageTitleKeys, type FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import { type SessionRef, sameSessionRef, sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import type { SkillInfo } from "@ling/contracts/skill";
import {
	dirtyFileDocumentsAtom,
	fileDocumentKey,
	getRetainedFileDocument,
} from "@renderer/features/files/file-document-state";
import { type ChangeReviewTarget, changeReviewTargetKey } from "@renderer/features/review/change-review-target";
import { requireWorkspaceSessionStatus, useWorkspaceSessionStatuses } from "@renderer/features/sessions/session-status";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectController } from "../projects/use-projects";
import type { SessionController } from "../sessions/use-sessions";
import {
	closeReadingTabsAtom,
	keepReadingTabOpenAtom,
	openReadingTabAtom,
	reorderReadingTabAtom,
	sessionWorkbenchesAtom,
	updateReadingWorkspaceAtom,
	useReadingWorkspace,
} from "./reading-state";
import {
	focusedTabGroupAtom,
	keepSessionTabOpenAtom,
	moveTab,
	openSessionTabsAtom,
	orderSessionTabs,
	sessionPreviewAtom,
	reconcileTabOrder,
	replaceSessionPreviewAtom,
	tabAfterClosing,
	sessionTabOrderAtom,
} from "./tab-state";
import type { WorkspaceTab } from "./workspace-tabs";
import { editorRevealAtom, type EditorSelection } from "@renderer/features/files/editor-navigation";

interface WorkspaceTabsOptions {
	sessionController: SessionController;
	projects: ProjectController["projects"];
	showCommandError(error: unknown): void;
}

/** Group actions always use the context-menu target, independently of the active tab. */
function tabGroup(
	tabs: readonly WorkspaceTab[],
	activeKey: string | null,
	select: (key: string) => void,
	keepOpen: (key: string) => void,
	close: (keys: readonly string[]) => void,
	reorder: (key: string, target: string, edge: "before" | "after") => void,
) {
	return {
		tabs,
		activeKey,
		select,
		keepOpen,
		reorder,
		close: (key: string) => close([key]),
		closeOthers: (key: string) => close(tabs.filter((tab) => tab.key !== key).map((tab) => tab.key)),
		closeRight: (key: string) => {
			const index = tabs.findIndex((tab) => tab.key === key);
			if (index >= 0) close(tabs.slice(index + 1).map((tab) => tab.key));
		},
		closeAll: () => close(tabs.map((tab) => tab.key)),
		closeActive: () => {
			if (activeKey === null || !tabs.some((tab) => tab.key === activeKey)) return false;
			close([activeKey]);
			return true;
		},
		selectAdjacent: (direction: -1 | 1) => {
			if (tabs.length < 2) return;
			const index = tabs.findIndex((tab) => tab.key === activeKey);
			const next = tabs[(index + direction + tabs.length) % tabs.length];
			if (next !== undefined) select(next.key);
		},
	};
}

export function useWorkspaceTabs({ sessionController, projects, showCommandError }: WorkspaceTabsOptions) {
	const { sessions, activeSessionRef, deleteSession, selectSession, deselectSession } = sessionController;
	const store = useStore();
	const { t } = useTranslation();
	const [pendingClose, setPendingClose] = useState<{
		ref: SessionRef;
		keys: readonly string[];
		paths: string[];
	} | null>(null);
	const [closing, setClosing] = useState(false);
	const openTabs = useAtomValue(openSessionTabsAtom);
	const preview = useAtomValue(sessionPreviewAtom);
	const order = useAtomValue(sessionTabOrderAtom);
	const dirty = useAtomValue(dirtyFileDocumentsAtom);
	const [reading] = useReadingWorkspace(activeSessionRef);
	const activeSessionKey = activeSessionRef ? sessionKey(activeSessionRef) : null;
	const replacePreview = useSetAtom(replaceSessionPreviewAtom);
	const keepSessionTabOpen = useSetAtom(keepSessionTabOpenAtom);
	const selectConversation = useCallback(
		(ref: SessionRef) => {
			store.set(appPageAtom, null);
			if (!store.get(openSessionTabsAtom).some((tab) => sameSessionRef(tab, ref))) replacePreview(ref);
			store.set(focusedTabGroupAtom, "conversation");
			return selectSession(ref);
		},
		[replacePreview, selectSession, store],
	);

	// Resume and new-session selection may enter outside the tab strip. Closing a tab
	// without a selection change must not immediately recreate it as a preview.
	const observedSelection = useRef<string | null>(null);
	useEffect(() => {
		if (observedSelection.current === activeSessionKey) return;
		observedSelection.current = activeSessionKey;
		if (
			activeSessionRef !== null &&
			!store.get(openSessionTabsAtom).some((ref) => sameSessionRef(ref, activeSessionRef))
		)
			replacePreview(activeSessionRef);
	}, [activeSessionKey, activeSessionRef, replacePreview, store]);

	const refs = useMemo(
		() =>
			preview !== null && !openTabs.some((ref) => sameSessionRef(ref, preview)) ? [...openTabs, preview] : openTabs,
		[openTabs, preview],
	);
	const tabSessions = useMemo(
		() =>
			refs.flatMap((ref) => {
				const session = sessions.find((candidate) => sameSessionRef(toSessionRef(candidate), ref));
				// Discovery can lag saved membership. It is retained until the catalog catches up.
				return session === undefined ? [] : [session];
			}),
		[refs, sessions],
	);
	const statuses = useWorkspaceSessionStatuses(tabSessions, activeSessionRef);
	const conversationTabs = useMemo<WorkspaceTab[]>(() => {
		const items = tabSessions.map((session) => ({
			kind: "session" as const,
			key: sessionKey(toSessionRef(session)),
			ref: toSessionRef(session),
			title: session.title,
			projectName: projects.find((project) => project.cwd === session.cwd)?.name ?? session.cwd,
			status: requireWorkspaceSessionStatus(statuses, session).status,
			child: session.relation?.kind === "child",
			preview: sameSessionRef(preview, toSessionRef(session)),
		}));
		const positions = new Map(
			reconcileTabOrder(
				order,
				items.map((tab) => tab.key),
			).map((key, index) => [key, index]),
		);
		return items.sort((a, b) => positions.get(a.key)! - positions.get(b.key)!);
	}, [order, preview, projects, statuses, tabSessions]);
	useEffect(() => {
		store.set(sessionTabOrderAtom, (current) => {
			const available = reconcileTabOrder(current, refs.map(sessionKey));
			const savedKeys = openTabs.map(sessionKey),
				saved = new Set(savedKeys);
			let index = 0;
			const next = available.map((key) => (saved.has(key) ? savedKeys[index++]! : key));
			return next.length === current.length && next.every((key, i) => key === current[i]) ? current : next;
		});
	}, [openTabs, refs, store]);

	const selectConversationTab = useCallback(
		(key: string) => {
			const tab = conversationTabs.find((tab) => tab.key === key);
			if (tab?.kind === "session") void selectConversation(tab.ref).catch(showCommandError);
		},
		[conversationTabs, selectConversation, showCommandError],
	);
	const keepConversationTab = useCallback(
		(key: string) => {
			const tab = conversationTabs.find((tab) => tab.key === key);
			if (tab?.kind === "session") keepSessionTabOpen(tab.ref);
		},
		[conversationTabs, keepSessionTabOpen],
	);
	const closeConversations = useCallback(
		(keys: readonly string[]) => {
			const closing = new Set(keys);
			store.set(openSessionTabsAtom, (current) => current.filter((ref) => !closing.has(sessionKey(ref))));
			store.set(sessionPreviewAtom, (current) =>
				current !== null && closing.has(sessionKey(current)) ? null : current,
			);
			store.set(sessionTabOrderAtom, (current) => current.filter((key) => !closing.has(key)));
			if (activeSessionKey === null || !closing.has(activeSessionKey)) return;
			const next = tabAfterClosing(conversationTabs, activeSessionKey, closing);
			if (next !== null) selectConversationTab(next);
			else deselectSession();
		},
		[activeSessionKey, conversationTabs, deselectSession, selectConversationTab, store],
	);
	const reorderConversations = useCallback(
		(key: string, target: string, edge: "before" | "after") => {
			const next = moveTab(store.get(sessionTabOrderAtom), key, target, edge);
			keepConversationTab(key);
			store.set(sessionTabOrderAtom, next);
			store.set(openSessionTabsAtom, (current) => orderSessionTabs(current, next));
		},
		[keepConversationTab, store],
	);
	const conversationGroup = useMemo(
		() =>
			tabGroup(
				conversationTabs,
				activeSessionKey,
				selectConversationTab,
				keepConversationTab,
				closeConversations,
				reorderConversations,
			),
		[
			conversationTabs,
			activeSessionKey,
			selectConversationTab,
			keepConversationTab,
			closeConversations,
			reorderConversations,
		],
	);

	const readingTabs = useMemo<WorkspaceTab[]>(
		() =>
			reading.tabs.map((tab) =>
				tab.kind === "feature"
					? { ...tab, title: t(featurePageTitleKeys[tab.id]), preview: tab.key === reading.previewKey, dirty: false }
					: {
							...tab,
							preview: tab.key === reading.previewKey,
							dirty: tab.kind === "file" && dirty.has(fileDocumentKey(tab.cwd, tab.path)),
						},
			),
		[dirty, reading.tabs, reading.previewKey, t],
	);
	const activeViewer = reading.tabs.find((tab) => tab.key === reading.activeKey) ?? null;
	const activeReviewTarget: ChangeReviewTarget | null = activeViewer?.kind === "review" ? activeViewer : null;
	const selectReadingTab = useCallback(
		(key: string) => {
			if (activeSessionRef === null) return;
			store.set(focusedTabGroupAtom, "reading");
			store.set(updateReadingWorkspaceAtom, {
				ref: activeSessionRef,
				existingOnly: true,
				update: (current) => (current.tabs.some((tab) => tab.key === key) ? { ...current, activeKey: key } : current),
			});
		},
		[activeSessionRef, store],
	);
	const keepReadingTab = useCallback(
		(key: string) => {
			if (activeSessionRef !== null) store.set(keepReadingTabOpenAtom, { ref: activeSessionRef, key });
		},
		[activeSessionRef, store],
	);
	const closeReadingTabs = useCallback(
		(keys: readonly string[]) => {
			if (activeSessionRef === null) return;
			const closing = new Set(keys),
				dirty = store.get(dirtyFileDocumentsAtom);
			const paths = reading.tabs.flatMap((tab) =>
				closing.has(tab.key) && tab.kind === "file" && dirty.has(fileDocumentKey(tab.cwd, tab.path)) ? [tab.path] : [],
			);
			if (paths.length > 0) setPendingClose({ ref: activeSessionRef, keys, paths });
			else store.set(closeReadingTabsAtom, { ref: activeSessionRef, keys });
		},
		[activeSessionRef, reading.tabs, store],
	);
	const resolveClose = useCallback(
		async (action: "save" | "discard" | "cancel") => {
			if (closing || pendingClose === null) return;
			if (action === "cancel") {
				setPendingClose(null);
				return;
			}
			setClosing(true);
			try {
				const workspace = store.get(sessionWorkbenchesAtom).get(sessionKey(pendingClose.ref));
				if (!workspace) {
					setPendingClose(null);
					return;
				}
				const keys = new Set(pendingClose.keys);
				for (const tab of workspace.state.tabs) {
					if (
						tab.kind !== "file" ||
						!keys.has(tab.key) ||
						!store.get(dirtyFileDocumentsAtom).has(fileDocumentKey(tab.cwd, tab.path))
					)
						continue;
					const document = getRetainedFileDocument(fileDocumentKey(tab.cwd, tab.path));
					if (!document) throw new Error(t("reading.documentUnavailable", { path: tab.path }));
					if (action === "discard") document.discard();
					else if (!(await document.save())) throw new Error(t("reading.changedWhileSaving", { path: tab.path }));
				}
				store.set(closeReadingTabsAtom, { ref: pendingClose.ref, keys: pendingClose.keys });
				setPendingClose(null);
			} catch (error) {
				showCommandError(error);
			} finally {
				setClosing(false);
			}
		},
		[closing, pendingClose, showCommandError, store, t],
	);
	const reorderReadingTab = useCallback(
		(key: string, target: string, edge: "before" | "after") => {
			if (activeSessionRef !== null) store.set(reorderReadingTabAtom, { ref: activeSessionRef, key, target, edge });
		},
		[activeSessionRef, store],
	);
	const readingGroup = useMemo(
		() =>
			tabGroup(readingTabs, reading.activeKey, selectReadingTab, keepReadingTab, closeReadingTabs, reorderReadingTab),
		[readingTabs, reading.activeKey, selectReadingTab, keepReadingTab, closeReadingTabs, reorderReadingTab],
	);
	const openViewer = useCallback(
		(path: string, keepOpen = false, range?: EditorSelection) => {
			if (activeSessionRef === null) return;
			keepSessionTabOpen(activeSessionRef);
			const cwd = activeSessionRef.cwd;
			store.set(openReadingTabAtom, {
				ref: activeSessionRef,
				tab: { kind: "file", key: ["file", cwd, path].join("\u0000"), path, cwd },
				keepOpen,
			});
			store.set(focusedTabGroupAtom, "reading");
			if (range)
				store.set(editorRevealAtom, { viewKey: sessionKey(activeSessionRef), path, range, nonce: crypto.randomUUID() });
		},
		[activeSessionRef, keepSessionTabOpen, store],
	);
	const openReviewViewer = useCallback(
		(target: ChangeReviewTarget) => {
			if (activeSessionRef === null) return;
			keepSessionTabOpen(activeSessionRef);
			store.set(openReadingTabAtom, {
				ref: activeSessionRef,
				tab: { kind: "review", key: changeReviewTargetKey(activeSessionRef, target), ref: activeSessionRef, ...target },
			});
			store.set(focusedTabGroupAtom, "reading");
		},
		[activeSessionRef, keepSessionTabOpen, store],
	);
	const openFeatureViewer = useCallback(
		(id: FeaturePageId, keepOpen = false) => {
			if (!activeSessionRef) return;
			keepSessionTabOpen(activeSessionRef);
			store.set(openReadingTabAtom, {
				ref: activeSessionRef,
				tab: { kind: "feature", key: `feature:${id}`, id },
				keepOpen,
			});
			store.set(focusedTabGroupAtom, "reading");
		},
		[activeSessionRef, keepSessionTabOpen, store],
	);
	const openSkillViewer = useCallback(
		(skill: SkillInfo) => {
			if (!activeSessionRef) return;
			keepSessionTabOpen(activeSessionRef);
			store.set(openReadingTabAtom, {
				ref: activeSessionRef,
				tab: { kind: "skill", key: ["skill", skill.filePath].join("\u0000"), skill },
			});
			store.set(focusedTabGroupAtom, "reading");
		},
		[activeSessionRef, keepSessionTabOpen, store],
	);
	useEffect(() => {
		const tab = reading.tabs.find((tab) => tab.key === reading.previewKey);
		if (tab?.kind === "file" && dirty.has(fileDocumentKey(tab.cwd, tab.path))) keepReadingTab(tab.key);
	}, [dirty, reading.tabs, reading.previewKey, keepReadingTab]);
	const closeActiveTab = useCallback(
		() => (store.get(focusedTabGroupAtom) === "reading" ? readingGroup : conversationGroup).closeActive(),
		[conversationGroup, readingGroup, store],
	);
	const selectAdjacentTab = useCallback(
		(direction: -1 | 1) =>
			(store.get(focusedTabGroupAtom) === "reading" ? readingGroup : conversationGroup).selectAdjacent(direction),
		[conversationGroup, readingGroup, store],
	);
	const deleteSessionAndTab = useCallback(
		async (ref: SessionRef) => {
			await deleteSession(ref);
			store.set(openSessionTabsAtom, (current) => current.filter((tab) => !sameSessionRef(tab, ref)));
			store.set(sessionPreviewAtom, (current) => (sameSessionRef(current, ref) ? null : current));
			store.set(sessionWorkbenchesAtom, (current) => {
				const next = new Map(current);
				next.delete(sessionKey(ref));
				return next;
			});
		},
		[deleteSession, store],
	);
	return useMemo(
		() => ({
			pendingClose,
			closing,
			resolveClose,
			conversationGroup,
			readingGroup,
			activeViewer,
			activeReviewTarget,
			openViewer,
			openReviewViewer,
			openFeatureViewer,
			openSkillViewer,
			selectConversation,
			keepSessionTabOpen,
			closeActiveTab,
			selectAdjacentTab,
			deleteSessionAndTab,
		}),
		[
			pendingClose,
			closing,
			resolveClose,
			conversationGroup,
			readingGroup,
			activeViewer,
			activeReviewTarget,
			openViewer,
			openReviewViewer,
			openFeatureViewer,
			openSkillViewer,
			selectConversation,
			keepSessionTabOpen,
			closeActiveTab,
			selectAdjacentTab,
			deleteSessionAndTab,
		],
	);
}
