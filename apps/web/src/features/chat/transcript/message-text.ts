export type TextBearingPart = { type: string; text?: string };

/** Text parts of a message joined with newlines — the one shared extraction rule for
 * transcript rows and the outline. */
export function partsText(content: string | TextBearingPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
