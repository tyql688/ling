import { sessionKey, toSessionRef, type SessionRef } from "@ling/contracts/session-ref";
import { forgetProjectProviderCatalog } from "@renderer/features/models/use-providers";
import {
	pinnedProjectCwdsAtom,
	projectDisplayNamesAtom,
	sidebarProjectScopeAtom,
} from "@renderer/features/projects/state";
import { evictRendererSessionState } from "@renderer/features/sessions/runtime/renderer-session-state";
import { sessionsAtom } from "@renderer/features/sessions/state/session";
import { forgetProjectTerminalWorkspace } from "@renderer/features/terminal/terminal-workspace-state";
import { useStore } from "jotai";
import { useMemo } from "react";
import { workspaceDialogAtom } from "./use-workspace-dialogs";
import { sessionPreviewAtom } from "./tab-state";
import { sessionWorkbenchesAtom } from "./reading-state";

/** Cross-feature deletion belongs to workspace composition, not to either catalog owner. */
export function useWorkspaceCleanup() {
	const store = useStore();
	return useMemo(() => {
		const clearRemovedViews = (removed: Set<string>, cwd?: string): void => {
			store.set(
				sessionWorkbenchesAtom,
				(current) =>
					new Map(
						[...current].filter(([key, value]) => !removed.has(key) && (cwd === undefined || value.ref?.cwd !== cwd)),
					),
			);
			store.set(sessionPreviewAtom, (ref) =>
				ref !== null && (ref.cwd === cwd || removed.has(sessionKey(ref))) ? null : ref,
			);
			store.set(workspaceDialogAtom, (dialog) => {
				if (dialog === null) return null;
				const target = dialog.target;
				const ref = "ref" in target ? target.ref : null;
				const projectCwd = ref?.cwd ?? ("cwd" in target ? target.cwd : null);
				return projectCwd === cwd || (ref !== null && removed.has(sessionKey(ref))) ? null : dialog;
			});
		};
		const onSessionsRemoved = (refs: readonly SessionRef[]): void => {
			if (refs.length === 0) return;
			clearRemovedViews(new Set(refs.map(sessionKey)));
			evictRendererSessionState(store, refs);
		};
		const onProjectRemoved = (cwd: string): void => {
			const refs = store
				.get(sessionsAtom)
				.filter((session) => session.cwd === cwd)
				.map(toSessionRef);
			onSessionsRemoved(refs);
			clearRemovedViews(new Set(refs.map(sessionKey)), cwd);
			store.set(sessionsAtom, (current) => current.filter((session) => session.cwd !== cwd));
			forgetProjectTerminalWorkspace(cwd);
			forgetProjectProviderCatalog(cwd);
			store.set(pinnedProjectCwdsAtom, (current) => current.filter((entry) => entry !== cwd));
			store.set(projectDisplayNamesAtom, (current) => {
				if (!(cwd in current)) return current;
				const next = { ...current };
				delete next[cwd];
				return next;
			});
			if (store.get(sidebarProjectScopeAtom) === cwd) store.set(sidebarProjectScopeAtom, null);
		};
		return { onSessionsRemoved, onProjectRemoved };
	}, [store]);
}
