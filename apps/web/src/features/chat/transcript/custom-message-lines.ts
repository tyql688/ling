import type { RenderedCustomSessionMessage } from "@ling/contracts/session-messages";

type CustomMessageRenderVariant = "collapsed" | "expanded";

interface CustomMessageRenderedLineSelection {
	variant: CustomMessageRenderVariant;
	lines: string[];
}

/** Selects the custom renderer snapshot matching the global disclosure preference. */
export function selectCustomMessageRenderedLines(
	rendered: RenderedCustomSessionMessage | undefined,
	toolsExpanded: boolean,
): CustomMessageRenderedLineSelection | null {
	if (!rendered) return null;
	const preferred = toolsExpanded ? "expanded" : "collapsed";
	if (preferred === "expanded") {
		if (rendered.expandedLines !== undefined) return { variant: "expanded", lines: rendered.expandedLines };
		if (rendered.collapsedLines !== undefined) return { variant: "collapsed", lines: rendered.collapsedLines };
		return null;
	}
	if (rendered.collapsedLines !== undefined) return { variant: "collapsed", lines: rendered.collapsedLines };
	if (rendered.expandedLines !== undefined) return { variant: "expanded", lines: rendered.expandedLines };
	return null;
}
