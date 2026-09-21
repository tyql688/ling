/** Initial width advertised before the extension dock mounts and can be measured. */
const DEFAULT_DOCK_WIDTH = 320;

/**
 * Horizontal chrome between the dock's outer width and a widget's text: the body's padding, the
 * widget card's padding, and the card borders. Extension components render to an exact column
 * count, so this is what separates "fits" from "clipped mid-line".
 */
const EXTENSION_DOCK_CONTENT_INSET = 2 * 12 + 2 * 10 + 2;

/**
 * Type styles for a line of extension output in the dock. Shared so the column count reported to
 * the extension host is measured in the same cell the lines are drawn in — if these drift, every
 * component renders to the wrong width.
 */
export const EXTENSION_DOCK_LINE_CLASS = "font-mono text-xs leading-4";

export function readExtensionDockContentWidth(): number {
	const visible = Array.from(document.querySelectorAll<HTMLElement>("[data-extension-dock]")).find(
		(element) => !element.closest("[inert]") && element.getBoundingClientRect().width > 0,
	);
	const rendered = visible ? visible.getBoundingClientRect().width : Math.min(DEFAULT_DOCK_WIDTH, window.innerWidth);
	return Math.max(1, rendered - EXTENSION_DOCK_CONTENT_INSET);
}
