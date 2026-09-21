import type {
	ChangeReviewFile,
	ChangeReviewScope,
	ChangeReviewSnapshot,
	ChangeReviewTrackingState,
	CommitChangeReviewRequest,
} from "@ling/contracts/git";

import type { SessionRef } from "@ling/contracts/session-ref";

import {
	changeReviewNavigationReducer,
	INITIAL_CHANGE_REVIEW_NAVIGATION,
} from "@renderer/features/review/change-review-navigation";

import { isWindows } from "@renderer/lib/platform";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import {
	filesForChangeReviewTarget,
	type ChangeReviewTarget,
	type ChangeReviewWorkspaceScope,
} from "./change-review-target";

import { useChangeReviewReviewed } from "./use-change-review-reviewed";

import { useChangeReviewWriteFlow } from "./use-change-review-write-flow";

function canChangeScope(
	scope: ChangeReviewScope,
	files: readonly ChangeReviewFile[],
): scope is CommitChangeReviewRequest["scope"] {
	if (scope === "external" || scope === "mixed" || scope === "committed" || scope === "unpushed") return false;
	return (
		files.length > 0 &&
		files.every(
			(file) =>
				file.owner !== "external" && file.owner !== "mixed" && file.status !== "clean" && file.status !== "conflicted",
		)
	);
}

function trackingForScope(
	snapshot: ChangeReviewSnapshot,
	scope: ChangeReviewScope,
	turnId: string | null,
): ChangeReviewTrackingState | null {
	if (scope === "turn") {
		if (turnId !== null) return snapshot.turns.find((turn) => turn.id === turnId)?.tracking ?? null;
		return snapshot.tracking.turn;
	}
	if (scope === "session") return snapshot.tracking.session;
	return null;
}

function partialTrackingMessageKey(
	reason: Extract<ChangeReviewTrackingState, { status: "partial" }>["reason"],
): string {
	switch (reason) {
		case "shadowCaptureFailed":
			return "changes.trackingPartialShadowCaptureFailed";
		case "captureLimitExceeded":
			return "changes.trackingPartialCaptureLimitExceeded";
		case "toolFallbackFailed":
			return "changes.trackingPartialToolFallbackFailed";
		case "legacyTracking":
			return "changes.trackingPartialLegacy";
	}
}
export type ChangeReviewPanelProps = {
	sessionRef: SessionRef;
	open: boolean;
	/** A file (tool-arg path, possibly absolute) to select once the snapshot lists it. */
	focusFile?: string | null | undefined;
	onFocusFileHandled?: (() => void) | undefined;
	/** Scope adopted each time the panel opens: "session" from the workspace controls, "turn" from
	 * the timeline's turn pill. */
	requestedScope: ChangeReviewWorkspaceScope;
	/** The workspace retains navigation per session; standalone dialogs own their scope locally. */
	onScopeChange?: ((scope: ChangeReviewWorkspaceScope) => void) | undefined;
	/** Historical turn selected by a timeline card; null means the live/latest turn scope. */
	requestedTurnId: string | null;
	snapshot: ChangeReviewSnapshot | null;
	loading: boolean;
	error: string | null;
	stateRecoveryError: string | null;
	onOpenChange: (open: boolean) => void;
	onRefresh: () => void;
	onCopyPath: (path: string) => void;
	/** Inline in the workspace side panel (no dialog chrome). */
	docked?: boolean | undefined;
	/** Active main-area diff; used to highlight the navigator row. */
	activeTarget?: ChangeReviewTarget | null | undefined;
	/** When present, the docked panel is navigation-only and opens details in the main area. */
	onOpenFile?: ((target: ChangeReviewTarget) => void) | undefined;
};

/** Owns the form's asynchronous work, recovery state and submission intent. */
export function useChangeReviewPanel({
	sessionRef,
	open,
	focusFile,
	onFocusFileHandled,
	requestedScope,
	onScopeChange,
	requestedTurnId,
	snapshot,
	loading,
	error,
	stateRecoveryError,
	onOpenChange,
	onRefresh,
	onCopyPath,
	docked,
	activeTarget,
	onOpenFile,
}: ChangeReviewPanelProps) {
	const { t } = useTranslation();
	const [localScope, setScope] = useState<ChangeReviewWorkspaceScope>(requestedScope);
	const controlledScope = onScopeChange !== undefined;
	const scope = controlledScope ? requestedScope : localScope;
	/** Allows one automatic scope fallback when the panel opens; a manual switch disables it immediately so it never hijacks again. */
	const scopeAutoRef = useRef(false);
	const reviewed = useChangeReviewReviewed(sessionRef);
	const [navigation, dispatchNavigation] = useReducer(changeReviewNavigationReducer, INITIAL_CHANGE_REVIEW_NAVIGATION);
	const writes = useChangeReviewWriteFlow({ sessionRef, onRefresh });
	const { dismissWriteDialogs } = writes;
	const navigatorOnly = docked === true && onOpenFile !== undefined;
	const viewingHistoricalTurn = scope === "turn" && requestedTurnId !== null;
	const targetTurnId = scope === "turn" ? requestedTurnId : null;
	const files = filesForChangeReviewTarget(snapshot, { scope, turnId: targetTurnId });
	const tracking = snapshot ? trackingForScope(snapshot, scope, requestedTurnId) : null;
	const selectFile = (path: string): void => {
		if (navigatorOnly) onOpenFile?.({ scope, turnId: targetTurnId, path });
		else dispatchNavigation({ type: "selectFile", path });
	};

	useEffect(() => {
		if (!focusFile || !open || files.length === 0) return;
		const normalized = isWindows ? focusFile.replace(/\\/g, "/") : focusFile;
		const match = files.find((file) => file.path === normalized || normalized.endsWith(`/${file.path}`));
		if (match) {
			if (navigatorOnly) onOpenFile?.({ scope, turnId: targetTurnId, path: match.path });
			else dispatchNavigation({ type: "selectFile", path: match.path });
		}
		// One attempt against a loaded list, hit or miss — a stale focus request must not
		// linger and hijack the selection on a later snapshot refresh.
		onFocusFileHandled?.();
	}, [focusFile, open, files, navigatorOnly, onFocusFileHandled, onOpenFile, scope, targetTurnId]);

	const canChange = snapshot?.isRepository === true && !viewingHistoricalTurn && canChangeScope(scope, files);
	const activePath =
		navigatorOnly && activeTarget != null && activeTarget.scope === scope && activeTarget.turnId === targetTurnId
			? activeTarget.path
			: null;
	const selectedPath = navigatorOnly ? activePath : navigation.selectedPath;
	const selectedFile = useMemo(() => files.find((file) => file.path === selectedPath) ?? null, [files, selectedPath]);
	const emptyMessage =
		scope !== "unpushed" || snapshot === null
			? t("changes.noData")
			: snapshot.unpushed.status === "ready"
				? snapshot.unpushed.commitCount === 0
					? t("changes.noUnpushed", { ref: snapshot.unpushed.comparisonRef })
					: t("changes.noUnpushedChanges", {
							count: snapshot.unpushed.commitCount,
							ref: snapshot.unpushed.comparisonRef,
						})
				: snapshot.unpushed.status === "error"
					? t("changes.unpushedLoadFailed", { message: snapshot.unpushed.message })
					: t("changes.unpushedNoUpstream");
	const emptyTone: "danger" | "info" =
		scope === "unpushed" && snapshot?.unpushed.status === "error" ? "danger" : "info";

	useEffect(() => {
		if (!open) {
			dismissWriteDialogs();
			return;
		}
		if (!navigatorOnly) dispatchNavigation({ type: "ensureSelection", paths: files.map((file) => file.path) });
	}, [files, open, dismissWriteDialogs, navigatorOnly]);

	useEffect(() => {
		if (!open) return;
		scopeAutoRef.current = !controlledScope;
		setScope(requestedScope);
		dispatchNavigation({ type: "resetScope" });
	}, [open, requestedScope, requestedTurnId, controlledScope]);

	// Prefer the first outstanding review surface when this session itself is empty.
	useEffect(() => {
		if (!open || !snapshot || viewingHistoricalTurn || scope !== "session" || !scopeAutoRef.current) return;
		if (snapshot.scopes.session.files.length > 0) return;
		const fallbackScope =
			snapshot.scopes.workspace.files.length > 0
				? "workspace"
				: snapshot.scopes.unpushed.files.length > 0
					? "unpushed"
					: null;
		if (fallbackScope === null) return;
		scopeAutoRef.current = false;
		setScope(fallbackScope);
		dispatchNavigation({ type: "resetScope" });
	}, [open, snapshot, scope, viewingHistoricalTurn]);

	const changeScope = (next: ChangeReviewWorkspaceScope): void => {
		if (next === scope) return;
		scopeAutoRef.current = false;
		if (onScopeChange) onScopeChange(next);
		else setScope(next);
		dispatchNavigation({ type: "resetScope" });
	};

	const closePanel = (): void => {
		onOpenChange(false);
	};
	const nestedDialogOpen = writes.writeDialogOpen;
	const handlePanelOpenChange = (nextOpen: boolean): void => {
		if (nextOpen) {
			onOpenChange(true);
			return;
		}
		if (nestedDialogOpen) return;
		closePanel();
	};

	const panelDescription = stateRecoveryError
		? t("changes.stateReadErrorTitle")
		: (error ??
			(snapshot
				? snapshot.isRepository
					? scope === "unpushed" && snapshot.unpushed.status === "ready"
						? t("changes.unpushedAgainst", {
								count: snapshot.unpushed.commitCount,
								ref: snapshot.unpushed.comparisonRef,
							})
						: t("changes.reviewDescription", { branch: snapshot.branch ?? "—" })
					: t("changes.reviewDescriptionTracked")
				: t("changes.loading")));
	return {
		docked,
		open,
		nestedDialogOpen,
		t,
		panelDescription,
		handlePanelOpenChange,
		snapshot,
		stateRecoveryError,
		error,
		scope,
		canChange,
		loading,
		selectedFile,
		canChangeScope,
		files,
		writes,
		onRefresh,
		onCopyPath,
		closePanel,
		changeScope,
		tracking,
		partialTrackingMessageKey,
		navigatorOnly,
		selectedPath,
		reviewed,
		selectFile,
		emptyMessage,
		emptyTone,
		navigation,
		sessionRef,
		viewingHistoricalTurn,
		requestedTurnId,
		dispatchNavigation,
	};
}
