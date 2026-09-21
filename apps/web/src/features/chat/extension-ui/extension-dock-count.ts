import type { ExtensionUiStateSnapshot } from "@ling/contracts/session-extension-ui";
import { projectExtensionTerminalText } from "./extension-terminal-text";

export type ExtensionWidget = ExtensionUiStateSnapshot["widgets"][number];

export function hasVisibleTerminalText(value: string): boolean {
	return projectExtensionTerminalText(value).trim().length > 0;
}

export function visibleWidgets(widgets: ExtensionUiStateSnapshot["widgets"]): ExtensionWidget[] {
	return widgets.filter((widget) => widget.lines.some(hasVisibleTerminalText));
}

/** Number of extension activities counted in the Dock badge (notifications / status / widget / footer). */
export function countExtensionDockItems(state: ExtensionUiStateSnapshot): number {
	const statusCount =
		state.footerLines === null ? state.statuses.filter((status) => hasVisibleTerminalText(status.text)).length : 0;
	const footerCount = state.footerLines?.some(hasVisibleTerminalText) ? 1 : 0;
	return state.notifications.length + statusCount + footerCount + visibleWidgets(state.widgets).length;
}
