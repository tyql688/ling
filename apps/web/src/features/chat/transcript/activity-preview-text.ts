function stripInlineMarkdown(line: string): string {
	return line
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s?/, "")
		.replace(/^(?:[-*+] |\d+[.)] )/, "")
		.replace(/^\[[ xX]\]\s+/, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/(^|[\s([{])\*\*([^*\n]+)\*\*(?=$|[\s)\]},.!?:;])/g, "$1$2")
		.replace(/(^|[\s([{])__([^_\n]+)__(?=$|[\s)\]},.!?:;])/g, "$1$2")
		.replace(/(^|[\s([{])~~([^~\n]+)~~(?=$|[\s)\]},.!?:;])/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s)\]},.!?:;])/g, "$1$2")
		.replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s)\]},.!?:;])/g, "$1$2")
		.trim();
}

function nonEmptyLines(markdown: string): string[] {
	return markdown
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** Opening line: the stable summary of a block that has finished writing. */
export function activityPreviewText(markdown: string): string {
	const line = nonEmptyLines(markdown)[0];
	return line === undefined ? "" : stripInlineMarkdown(line);
}

/**
 * Newest line: what a block is writing right now. A collapsed streaming row summarised by its
 * opening line would freeze on the first sentence for the whole turn and read as stalled.
 */
export function activityStreamingPreviewText(markdown: string): string {
	const line = nonEmptyLines(markdown).at(-1);
	return line === undefined ? "" : stripInlineMarkdown(line);
}
