import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import { EXTENSION_UI_RENDER_WIDTH, type ExtensionOverlayViewport } from "./extension-ui-overlay-layout";

/**
 * The renderer's surfaces measured in monospace columns. A TUI component is asked to draw at an
 * exact width, so each surface reports its own: an overlay spans the window, the header sits in
 * the transcript column, and widgets/footer live in the extension dock. Rendering everything at
 * one width is what clips dock content mid-line.
 */
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

	/** Width for the header, which renders inline at the top of the transcript rather than in the dock. */
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
