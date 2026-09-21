import { useDomainApi } from "@renderer/lib/host-api-context";
import type { PendingFileReference } from "@ling/contracts/draft";
import { PROJECT_FILE_REFERENCE_MAX_ITEMS } from "@ling/contracts/project";
import {
	draftWithProjectFileReference,
	fileReferenceTarget,
	type InsertFileReferenceOptions,
} from "@renderer/features/sessions/state/composer-file-references";
import { EMPTY_DRAFT } from "@renderer/features/sessions/state/drafts";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
} from "./workspace-state";

export function useWorkspaceFileActions() {
	const hostProjectApi = useDomainApi("project");
	const hostUiApi = useDomainApi("ui");

	const { t } = useTranslation();
	const showCommandError = useCommandFeedback();
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const activeSessionKey = useWorkspaceField(workspaceSelectionAtom, "activeSessionKey");
	const activeCwd = useWorkspaceField(workspaceSelectionAtom, "activeCwd");
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { setDrafts, setComposerFocusRequestId } = useWorkspaceOwner(workspaceSessionActionsAtom);
	const showComposerCommandError = useCallback(
		(message: string) => showCommandError(new Error(message)),
		[showCommandError],
	);

	const openComposerFileReference = useCallback(
		(reference: PendingFileReference) => {
			if (activeSessionRef === null) return;
			if (reference.scope === "project") {
				workbenchPanel.openExplorer({ path: reference.path, directory: reference.directory === true });
				return;
			}
			void hostProjectApi
				.revealFileReference({ cwd: activeSessionRef.cwd, reference: fileReferenceTarget(reference) })
				.catch(showCommandError);
		},
		[hostProjectApi, activeSessionRef, showCommandError, workbenchPanel],
	);

	const copyProjectPath = useCallback(
		(path: string) => void navigator.clipboard.writeText(path).catch(showCommandError),
		[showCommandError],
	);

	const revealProjectEntry = useMemo(
		() =>
			hostUiApi.capabilities.nativePathReveal
				? (path: string) => {
						if (activeCwd !== null) void hostProjectApi.revealEntry({ cwd: activeCwd, path }).catch(showCommandError);
					}
				: undefined,
		[hostUiApi, hostProjectApi, activeCwd, showCommandError],
	);

	const handleInsertProjectFileReference = useCallback(
		(path: string, options?: InsertFileReferenceOptions) => {
			if (activeSessionRef === null || activeSessionKey === null) return;
			let issue: "limit" | "duplicate" | null = null;
			setDrafts((current) => {
				const previous = current[activeSessionKey] ?? EMPTY_DRAFT;
				const result = draftWithProjectFileReference(previous, path, options);
				issue = result.issue;
				if (result.issue === "limit") return current;
				const draft = result.issue === null ? result.draft : previous;
				return {
					...current,
					[activeSessionKey]: options?.editorContext
						? { ...draft, text: [draft.text, options.editorContext].filter(Boolean).join("\n\n") }
						: draft,
				};
			});
			if (issue === "limit") {
				showComposerCommandError(t("session.fileReferenceLimit", { count: PROJECT_FILE_REFERENCE_MAX_ITEMS }));
				return;
			}
			setComposerFocusRequestId((current) => current + 1);
		},
		[activeSessionKey, activeSessionRef, setComposerFocusRequestId, setDrafts, showComposerCommandError, t],
	);

	return useMemo(
		() => ({
			showComposerCommandError,
			copyProjectPath,
			revealProjectEntry,
			handleInsertProjectFileReference,
			openComposerFileReference,
		}),
		[
			showComposerCommandError,
			copyProjectPath,
			revealProjectEntry,
			handleInsertProjectFileReference,
			openComposerFileReference,
		],
	);
}
