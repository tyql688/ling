/** Initial width advertised before the extension dock mounts and can be measured. */
const DEFAULT_DOCK_WIDTH = 320;

/** Combined body padding, widget-card padding and borders between the dock's outer edge and widget text. Subtract this width before computing the extension's column count. */
const EXTENSION_DOCK_CONTENT_INSET = 2 * 12 + 2 * 10 + 2;

/** Text styles shared by dock rendering and column measurement so extensions receive the width of the cells displayed on screen. */
export const EXTENSION_DOCK_LINE_CLASS = "font-mono text-xs leading-4";

export function readExtensionDockContentWidth(): number {
	const visible = Array.from(document.querySelectorAll<HTMLElement>("[data-extension-dock]")).find(
		(element) => !element.closest("[inert]") && element.getBoundingClientRect().width > 0,
	);
	const rendered = visible ? visible.getBoundingClientRect().width : Math.min(DEFAULT_DOCK_WIDTH, window.innerWidth);
	return Math.max(1, rendered - EXTENSION_DOCK_CONTENT_INSET);
}
