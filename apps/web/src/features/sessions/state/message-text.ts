/** Validate emptiness without normalizing the payload sent to the model. */
export function submitMessageText(text: string): string | null {
	return text.trim().length === 0 ? null : text;
}
