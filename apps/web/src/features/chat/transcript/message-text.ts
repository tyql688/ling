export type TextBearingPart = { type: string; text?: string };

/** Joins message text parts with newlines for transcript rows and the outline. */
export function partsText(content: string | TextBearingPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
