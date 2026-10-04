import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import { EXTENSION_UI_RENDER_WIDTH, type ExtensionOverlayViewport } from "./extension-ui-overlay-layout";

/** Each displayed area reports its width in monospace columns for TUI rendering: window width for overlays, transcript width for the header, and dock width for widgets and footer. */
export interface ExtensionUiViewport extends ExtensionOverlayViewport {
	markdownColumns: number;
	dockColumns: number;
}

export function createExtensionUiViewports() {
	const viewportBySession = new Map<string, ExtensionUiViewport>();

	function getExtensionUiViewport(ref: SessionRef): ExtensionUiViewport | undefined {
		return viewportBySession.get(sessionKey(ref));
	}

	function storeExtensionUiViewport(ref: SessionRef, viewport: ExtensionUiViewport): void {
		viewportBySession.set(sessionKey(ref), viewport);
	}

	function forgetExtensionUiViewport(ref: SessionRef): void {
		viewportBySession.delete(sessionKey(ref));
	}

	function getPiMarkdownViewportColumns(ref: SessionRef): number | undefined {
		return viewportBySession.get(sessionKey(ref))?.markdownColumns;
	}

	/** Width for the dock-bound surfaces (widgets, footer); falls back before the first measurement. */
	function widgetRenderColumns(ref: SessionRef): number {
		return viewportBySession.get(sessionKey(ref))?.dockColumns ?? EXTENSION_UI_RENDER_WIDTH;
	}

	/** Column width of the header at the top of the transcript. */
	function headerRenderColumns(ref: SessionRef): number {
		return viewportBySession.get(sessionKey(ref))?.markdownColumns ?? EXTENSION_UI_RENDER_WIDTH;
	}

	function dispose(): void {
		viewportBySession.clear();
	}
	return {
		getExtensionUiViewport,
		storeExtensionUiViewport,
		forgetExtensionUiViewport,
		getPiMarkdownViewportColumns,
		widgetRenderColumns,
		headerRenderColumns,
		dispose,
	};
}

export type ExtensionUiViewports = ReturnType<typeof createExtensionUiViewports>;
