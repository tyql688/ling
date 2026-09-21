/**
 * Collapse once the line count exceeds this. 8 lines ≈ a half-screen short bubble; longer
 * messages would squeeze the following assistant turns.
 */
const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
/**
 * Collapse once the character count exceeds this (long pastes without line breaks). Roughly
 * half a screen of plain text; either threshold triggers collapse.
 */
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

export function shouldCollapseUserMessage(text: string): boolean {
	if (text.trim().length === 0) return false;
	return text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH || text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES;
}
