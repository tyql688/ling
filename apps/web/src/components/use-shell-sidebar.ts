import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useMemo } from "react";

/** Breakpoint where the sidebar can dock: ≥54rem keeps enough conversation workspace; narrower uses a sheet. */
const DOCKED_SIDEBAR_QUERY = "(min-width: 54rem)";

export type ShellSidebarPresentation = "docked" | "sheet";
type ShellSidebarIntent = "open" | "close" | "toggle";

interface ShellSidebarState {
	presentation: ShellSidebarPresentation;
	dockedCollapsed: boolean;
	sheetOpen: boolean;
}

export interface ShellSidebarController extends ShellSidebarState {
	open: boolean;
	visible: boolean;
	previewOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;
	dismissSheet: () => void;
	setSheetOpen: (open: boolean) => void;
	schedulePreview: () => void;
	keepPreviewOpen: () => void;
	schedulePreviewClose: () => void;
}

function shellSidebarPresentation(matchesDockedQuery: boolean): ShellSidebarPresentation {
	return matchesDockedQuery ? "docked" : "sheet";
}

function resolveShellSidebarIntent(
	state: ShellSidebarState,
	intent: ShellSidebarIntent,
): Pick<ShellSidebarState, "dockedCollapsed" | "sheetOpen"> {
	if (state.presentation === "docked") {
		const open = !state.dockedCollapsed;
		const nextOpen = intent === "toggle" ? !open : intent === "open";
		return { dockedCollapsed: !nextOpen, sheetOpen: false };
	}

	const nextOpen = intent === "toggle" ? !state.sheetOpen : intent === "open";
	return { dockedCollapsed: state.dockedCollapsed, sheetOpen: nextOpen };
}

function subscribeToSidebarPresentation(onStoreChange: () => void): () => void {
	const mediaQuery = window.matchMedia(DOCKED_SIDEBAR_QUERY);
	mediaQuery.addEventListener("change", onStoreChange);
	return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getSidebarPresentation(): ShellSidebarPresentation {
	return shellSidebarPresentation(window.matchMedia(DOCKED_SIDEBAR_QUERY).matches);
}

function getServerSidebarPresentation(): ShellSidebarPresentation {
	return "docked";
}

export function useShellSidebar({
	dockedCollapsed,
	onDockedCollapsedChange,
}: {
	dockedCollapsed: boolean;
	onDockedCollapsedChange?: ((collapsed: boolean) => void) | undefined;
}): ShellSidebarController {
	const presentation = useSyncExternalStore(
		subscribeToSidebarPresentation,
		getSidebarPresentation,
		getServerSidebarPresentation,
	);
	const [sheetOpen, setSheetOpenState] = useState(false);
	const [dockedPreviewOpen, setDockedPreviewOpen] = useState(false);
	const previewShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewBlockedUntilRef = useRef(0);

	const clearPreviewTimers = useCallback(() => {
		if (previewShowTimerRef.current !== null) clearTimeout(previewShowTimerRef.current);
		if (previewHideTimerRef.current !== null) clearTimeout(previewHideTimerRef.current);
		previewShowTimerRef.current = null;
		previewHideTimerRef.current = null;
	}, []);

	// The sheet is transient by design. Crossing the breakpoint may dismiss it, but must never
	// rewrite the persisted dock preference supplied by the caller.
	useEffect(() => {
		if (presentation === "docked") {
			setSheetOpenState(false);
			return;
		}
		clearPreviewTimers();
		setDockedPreviewOpen(false);
	}, [clearPreviewTimers, presentation]);

	useEffect(() => {
		if (presentation !== "docked" || dockedCollapsed) return;
		clearPreviewTimers();
		setDockedPreviewOpen(false);
	}, [clearPreviewTimers, dockedCollapsed, presentation]);

	useEffect(() => clearPreviewTimers, [clearPreviewTimers]);

	const applyIntent = useCallback(
		(intent: ShellSidebarIntent) => {
			const next = resolveShellSidebarIntent({ presentation, dockedCollapsed, sheetOpen }, intent);
			if (presentation === "docked") {
				clearPreviewTimers();
				setDockedPreviewOpen(false);
				if (next.dockedCollapsed) previewBlockedUntilRef.current = Date.now() + 250;
				onDockedCollapsedChange?.(next.dockedCollapsed);
			}
			setSheetOpenState(next.sheetOpen);
		},
		[clearPreviewTimers, dockedCollapsed, onDockedCollapsedChange, presentation, sheetOpen],
	);

	const setSheetOpen = useCallback(
		(open: boolean) => {
			if (presentation === "sheet") setSheetOpenState(open);
		},
		[presentation],
	);
	const openSidebar = useCallback(() => applyIntent("open"), [applyIntent]);
	const closeSidebar = useCallback(() => applyIntent("close"), [applyIntent]);
	const toggleSidebar = useCallback(() => applyIntent("toggle"), [applyIntent]);
	const dismissSheet = useCallback(() => setSheetOpenState(false), []);
	const schedulePreview = useCallback(() => {
		if (presentation !== "docked" || !dockedCollapsed || Date.now() < previewBlockedUntilRef.current) return;
		clearPreviewTimers();
		previewShowTimerRef.current = setTimeout(() => {
			previewShowTimerRef.current = null;
			setDockedPreviewOpen(true);
		}, 100);
	}, [clearPreviewTimers, dockedCollapsed, presentation]);
	const keepPreviewOpen = useCallback(() => {
		if (previewHideTimerRef.current !== null) clearTimeout(previewHideTimerRef.current);
		previewHideTimerRef.current = null;
	}, []);
	const schedulePreviewClose = useCallback(() => {
		if (previewShowTimerRef.current !== null) clearTimeout(previewShowTimerRef.current);
		previewShowTimerRef.current = null;
		if (!dockedPreviewOpen) return;
		if (previewHideTimerRef.current !== null) clearTimeout(previewHideTimerRef.current);
		previewHideTimerRef.current = setTimeout(() => {
			previewHideTimerRef.current = null;
			setDockedPreviewOpen(false);
		}, 90);
	}, [dockedPreviewOpen]);
	const open = presentation === "docked" ? !dockedCollapsed : sheetOpen;

	return useMemo(
		() => ({
			presentation,
			dockedCollapsed,
			sheetOpen,
			open,
			visible: open || dockedPreviewOpen,
			previewOpen: dockedPreviewOpen,
			openSidebar,
			closeSidebar,
			toggleSidebar,
			dismissSheet,
			setSheetOpen,
			schedulePreview,
			keepPreviewOpen,
			schedulePreviewClose,
		}),
		[
			presentation,
			dockedCollapsed,
			sheetOpen,
			open,
			dockedPreviewOpen,
			openSidebar,
			closeSidebar,
			toggleSidebar,
			dismissSheet,
			setSheetOpen,
			schedulePreview,
			keepPreviewOpen,
			schedulePreviewClose,
		],
	);
}
