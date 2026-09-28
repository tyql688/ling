import type { SessionRef } from "@ling/contracts/session-ref";
import { useExtensionTerminalInput } from "@renderer/features/chat/extension-ui/use-extension-terminal-input";
import { isShortcutModifier } from "@renderer/lib/platform";
import { useEffect } from "react";

export function useWorkspaceGlobalShortcuts(options: {
	activeSessionRef: SessionRef | null;
	enabled: boolean;
	terminalInputListening: boolean;
	onNewConversation: () => void;
	closeActiveView: () => boolean;
	selectAdjacentTab: (direction: -1 | 1) => void;
	toggleSidebar: () => void;
	dismissSheet: () => void;
	toggleExplorer: () => void;
	toggleSidePanel: () => void;
	toggleTerminal: () => void;
	openTerminal: () => void;
	createTerminal: (cwd: string) => Promise<unknown>;
	terminalLoading: boolean;
	showCommandError: (error: unknown) => void;
}): void {
	const {
		activeSessionRef,
		enabled,
		terminalInputListening,
		onNewConversation,
		closeActiveView,
		selectAdjacentTab,
		toggleSidebar,
		dismissSheet,
		toggleExplorer,
		toggleSidePanel,
		toggleTerminal,
		openTerminal,
		createTerminal,
		terminalLoading,
		showCommandError,
	} = options;
	// Hidden-shell guard: while settings covers the workspace these listeners must not
	// intercept keystrokes typed into settings inputs.
	useExtensionTerminalInput({ activeSessionRef, terminalInputListening, enabled, showCommandError });

	useEffect(() => {
		if (!enabled) return;
		function handleKeyDown(event: KeyboardEvent) {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
			)
				return;
			if (!isShortcutModifier(event)) return;
			if ((event.key === "PageDown" || event.key === "PageUp") && !event.altKey && !event.shiftKey) {
				event.preventDefault();
				selectAdjacentTab(event.key === "PageDown" ? 1 : -1);
				return;
			}
			if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.altKey && !event.shiftKey) {
				event.preventDefault();
				selectAdjacentTab(event.key === "ArrowRight" ? 1 : -1);
				return;
			}
			if (event.key.toLowerCase() === "w" && !event.altKey && !event.shiftKey) {
				if (closeActiveView()) event.preventDefault();
				return;
			}
			if (event.code === "Backquote" && !event.altKey) {
				event.preventDefault();
				if (event.repeat || !activeSessionRef) return;
				if (event.shiftKey) {
					openTerminal();
					if (terminalLoading) return;
					void createTerminal(activeSessionRef.cwd).catch(showCommandError);
				} else {
					toggleTerminal();
				}
				return;
			}
			const key = event.key.toLowerCase();
			if (key === "e" && event.shiftKey && !event.altKey) {
				event.preventDefault();
				if (event.repeat) return;
				toggleExplorer();
				return;
			}
			if (key === "b") {
				event.preventDefault();
				toggleSidebar();
				return;
			}
			if (key === "j" && !event.shiftKey && !event.altKey) {
				event.preventDefault();
				if (!event.repeat) toggleSidePanel();
				return;
			}
			if (key !== "n") return;
			event.preventDefault();
			onNewConversation();
			dismissSheet();
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		activeSessionRef,
		onNewConversation,
		closeActiveView,
		selectAdjacentTab,
		dismissSheet,
		toggleSidebar,
		toggleTerminal,
		openTerminal,
		showCommandError,
		createTerminal,
		terminalLoading,
		toggleExplorer,
		toggleSidePanel,
		enabled,
	]);
}
