/** DataTransfer.types is a frozen string array in Chromium but DOMStringList per spec. */
export function dragPayloadHasFiles(types: ReadonlyArray<string> | DOMStringList): boolean {
	return Array.prototype.includes.call(types, "Files");
}

interface DropDepthUpdate {
	depth: number;
	active: boolean;
}

/** Count nested dragenter/dragleave events so the drop highlight stays visible as the pointer crosses editor elements and thumbnails. */
export function trackDropDepth(depth: number, transition: "enter" | "leave" | "reset"): DropDepthUpdate {
	const next = transition === "enter" ? depth + 1 : transition === "leave" ? Math.max(0, depth - 1) : 0;
	return { depth: next, active: next > 0 };
}
