/**
 * Workspace chrome rhythm. Each number states what breaks if it moves.
 */

/** 44px window title strip — shorter overlaps macOS traffic lights. */
export const CHROME_TITLEBAR_CLASS = "h-11";

/**
 * 272px docked sidebar. 256px truncates 13px session titles; 280px is Lody's
 * ceiling and starts crowding the composer on a 1280px window.
 */
export const CHROME_SIDEBAR_WIDTH_CLASS = "w-[272px]";

/** The stage reveals native material or artwork; panes and floating controls own their tint. */
export const CHROME_CONTENT_REGION_CLASS = "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-shell-content";

/** Sidebar is the canvas, not a matching card. Skins tint --color-sidebar. */
export const CHROME_SIDEBAR_SHEET_CLASS = "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-sidebar";

/** Floating workbench dialog header (file tree / review when undocked). Two-line title + path. */
const WORKSPACE_PANEL_HEADER_HEIGHT_CLASS = "h-14";

/** Secondary toolbar inside panels (tree root, file preview path, terminal tabs). */
const WORKSPACE_SUBHEADER_HEIGHT_CLASS = "h-9";

/** Shared panel header layout: height + bottom border + horizontal padding. */
export const WORKSPACE_PANEL_HEADER_CLASS = `flex ${WORKSPACE_PANEL_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-2 border-b border-border-subtle bg-workbench-chrome px-3`;

/** Shared secondary subheader layout. */
export const WORKSPACE_SUBHEADER_CLASS = `flex ${WORKSPACE_SUBHEADER_HEIGHT_CLASS} shrink-0 items-center gap-2 border-b border-border-subtle bg-workbench-chrome px-3`;
