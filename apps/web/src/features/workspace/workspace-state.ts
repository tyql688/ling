import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionSummary } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import type { useShellSidebar } from "@renderer/components/use-shell-sidebar";
import type { useWorkbenchPanel } from "@renderer/components/workbench/use-workbench-panel";
import { atom, useAtomValue, useStore, type PrimitiveAtom } from "jotai";
import { useLayoutEffect, useMemo } from "react";
import type { useSessionNavigationHistory } from "./use-session-navigation-history";
import type { useWorkspaceModelFeedback } from "./use-workspace-model-feedback";
import type { WorkspaceShellProps } from "./use-workspace-runtime";
import type { useWorkspaceSidebarState } from "./use-workspace-sidebar-state";
import type { useWorkspaceTabs } from "./use-workspace-tabs";
import type { useWorkspaceSessionActions } from "./workspace-session-actions";

export const workspaceSelectionAtom = atom<
	| (WorkspaceShellProps & {
			sessions: SessionSummary[];
			projects: OpenProjectInfo[];
			activeSessionRef: SessionRef | null;
			activeSessionKey: string | null;
			runtimeSessionRef: SessionRef | null;
			sessionRuntimeOpening: boolean;
			activeCwd: string | null;
			activeSession: SessionSummary | undefined;
			activeSessionIsChild: boolean;
			activeParentSession: SessionSummary | undefined;
			activeProject: OpenProjectInfo | undefined;
			emptyStateCwd: string | null;
	  })
	| null
>(null);
export const workspaceSidebarAtom = atom<{
	shellSidebar: ReturnType<typeof useShellSidebar>;
	workspaceSidebarState: ReturnType<typeof useWorkspaceSidebarState>;
	sidebarSessionController: WorkspaceShellProps["sessionController"];
} | null>(null);
export const workspaceModelFeedbackAtom = atom<ReturnType<typeof useWorkspaceModelFeedback> | null>(null);
export const workspaceTabsAtom = atom<ReturnType<typeof useWorkspaceTabs> | null>(null);
export const workspacePanelAtom = atom<ReturnType<typeof useWorkbenchPanel> | null>(null);
export const workspaceSessionActionsAtom = atom<ReturnType<typeof useWorkspaceSessionActions> | null>(null);
export const workspaceHistoryAtom = atom<ReturnType<typeof useSessionNavigationHistory> | null>(null);

/** Publishes a React-owned controller before paint; consumers subscribe to that owner only. */
export function usePublishWorkspaceOwner<Value>(owner: PrimitiveAtom<Value | null>, value: Value) {
	const store = useStore();
	useLayoutEffect(() => {
		store.set(owner, value);
	}, [owner, store, value]);
	useLayoutEffect(
		() => () => {
			store.set(owner, null);
		},
		[owner, store],
	);
}

export function useWorkspaceOwner<Value>(owner: PrimitiveAtom<Value | null>): Value {
	const value = useAtomValue(owner);
	if (value === null) throw new Error("Workspace owner is not mounted");
	return value;
}

/** Selection fields do not inherit unrelated owner updates, including another view's loading state. */
export function useWorkspaceField<Value extends object, Key extends keyof Value>(
	owner: PrimitiveAtom<Value | null>,
	key: Key,
): Value[Key] {
	const field = useMemo(
		() =>
			atom((get) => {
				const value = get(owner);
				if (value === null) throw new Error("Workspace owner is not mounted");
				return value[key];
			}),
		[owner, key],
	);
	return useAtomValue(field);
}
