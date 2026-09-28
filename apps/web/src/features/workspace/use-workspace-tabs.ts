import { appPageAtom } from "@renderer/lib/navigation-state";
import { featurePageTitleKeys, type FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import {
	dirtyFileDocumentsAtom,
	fileDocumentKey,
	getRetainedFileDocument,
} from "@renderer/features/files/file-document-state";
import { type ChangeReviewTarget, changeReviewTargetKey } from "@renderer/features/review/change-review-target";
import { useAtomValue, useStore } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionController } from "../sessions/use-sessions";
import {
	closeReadingTabsAtom,
	openReadingTabAtom,
	reorderReadingTabAtom,
	sessionWorkbenchesAtom,
	updateReadingWorkspaceAtom,
	useReadingWorkspace,
	withFeatureTab,
} from "./reading-state";
import { focusedTabGroupAtom } from "./tab-state";
import type { WorkspaceTab } from "./workspace-tabs";
import { editorRevealAtom, type EditorSelection } from "@renderer/features/files/editor-navigation";

interface WorkspaceTabsOptions {
	sessionController: SessionController;
	showCommandError(error: unknown): void;
}

/** Group actions always use the context-menu target, independently of the active tab. */
function tabGroup(
	tabs: readonly WorkspaceTab[],
	activeKey: string | null,
	select: (key: string) => void,
	close: (keys: readonly string[]) => void,
	reorder: (key: string, target: string, edge: "before" | "after") => void,
) {
	return {
		tabs,
		activeKey,
		select,
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

export function useWorkspaceTabs({ sessionController, showCommandError }: WorkspaceTabsOptions) {
	const { activeSessionRef, deleteSession, selectSession, deselectSession } = sessionController;
	const store = useStore();
	const { t } = useTranslation();
	const [pendingClose, setPendingClose] = useState<{
		ref: SessionRef;
		keys: readonly string[];
		paths: string[];
	} | null>(null);
	const [closing, setClosing] = useState(false);
	const dirty = useAtomValue(dirtyFileDocumentsAtom);
	const [reading] = useReadingWorkspace(activeSessionRef);
	const selectConversation = useCallback(
		(ref: SessionRef) => {
			store.set(appPageAtom, null);
			store.set(focusedTabGroupAtom, "conversation");
			return selectSession(ref);
		},
		[selectSession, store],
	);

	const readingTabs = useMemo<WorkspaceTab[]>(
		() =>
			reading.tabs.map((tab) =>
				tab.kind === "feature"
					? { ...tab, title: t(featurePageTitleKeys[tab.id]), dirty: false }
					: {
							...tab,
							dirty: tab.kind === "file" && dirty.has(fileDocumentKey(tab.cwd, tab.path)),
						},
			),
		[dirty, reading.tabs, t],
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
		() => tabGroup(readingTabs, reading.activeKey, selectReadingTab, closeReadingTabs, reorderReadingTab),
		[readingTabs, reading.activeKey, selectReadingTab, closeReadingTabs, reorderReadingTab],
	);
	const openViewer = useCallback(
		(path: string, range?: EditorSelection) => {
			if (activeSessionRef === null) return;
			const cwd = activeSessionRef.cwd;
			store.set(openReadingTabAtom, {
				ref: activeSessionRef,
				tab: { kind: "file", key: ["file", cwd, path].join("\u0000"), path, cwd },
			});
			store.set(focusedTabGroupAtom, "reading");
			if (range)
				store.set(editorRevealAtom, { viewKey: sessionKey(activeSessionRef), path, range, nonce: crypto.randomUUID() });
		},
		[activeSessionRef, store],
	);
	const openReviewViewer = useCallback(
		(target: ChangeReviewTarget) => {
			if (activeSessionRef === null) return;
			store.set(openReadingTabAtom, {
				ref: activeSessionRef,
				tab: { kind: "review", key: changeReviewTargetKey(activeSessionRef, target), ref: activeSessionRef, ...target },
			});
			store.set(focusedTabGroupAtom, "reading");
		},
		[activeSessionRef, store],
	);
	const openFeatureViewer = useCallback(
		(id: FeaturePageId) => {
			if (!activeSessionRef) return;
			store.set(updateReadingWorkspaceAtom, {
				ref: activeSessionRef,
				update: (current) => withFeatureTab(current, id),
			});
			store.set(focusedTabGroupAtom, "reading");
		},
		[activeSessionRef, store],
	);
	const closeActiveView = useCallback(() => {
		if (store.get(focusedTabGroupAtom) === "reading" && reading.panel.open) return readingGroup.closeActive();
		if (activeSessionRef === null) return false;
		deselectSession();
		return true;
	}, [activeSessionRef, deselectSession, reading.panel.open, readingGroup, store]);
	const selectAdjacentTab = useCallback(
		(direction: -1 | 1) => {
			if (store.get(focusedTabGroupAtom) === "reading" && reading.panel.open) readingGroup.selectAdjacent(direction);
		},
		[reading.panel.open, readingGroup, store],
	);
	const deleteSessionAndViews = useCallback(
		async (ref: SessionRef) => {
			await deleteSession(ref);
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
			readingGroup,
			activeViewer,
			activeReviewTarget,
			openViewer,
			openReviewViewer,
			openFeatureViewer,
			selectConversation,
			closeActiveView,
			selectAdjacentTab,
			deleteSessionAndViews,
		}),
		[
			pendingClose,
			closing,
			resolveClose,
			readingGroup,
			activeViewer,
			activeReviewTarget,
			openViewer,
			openReviewViewer,
			openFeatureViewer,
			selectConversation,
			closeActiveView,
			selectAdjacentTab,
			deleteSessionAndViews,
		],
	);
}
