/** DataTransfer.types is a frozen string array in Chromium but DOMStringList per spec. */
export function dragPayloadHasFiles(types: ReadonlyArray<string> | DOMStringList): boolean {
	return Array.prototype.includes.call(types, "Files");
}

interface DropDepthUpdate {
	depth: number;
	active: boolean;
}

/**
 * dragenter/dragleave fire for every child element crossed, so a drop zone must count
 * depth instead of toggling a boolean — otherwise the highlight flickers off while the
 * pointer moves over the editor or thumbnails inside the zone.
 */
export function trackDropDepth(depth: number, transition: "enter" | "leave" | "reset"): DropDepthUpdate {
	const next = transition === "enter" ? depth + 1 : transition === "leave" ? Math.max(0, depth - 1) : 0;
	return { depth: next, active: next > 0 };
}
