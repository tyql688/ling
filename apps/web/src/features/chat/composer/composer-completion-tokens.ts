/** Completion token under the cursor, shared by the session and quick-start composers. */
export interface ComposerCompletionToken {
	start: number;
	/** Text between the trigger character and the cursor — the filter query. */
	query: string;
	/** Exclusive end of the whole token; extends past the cursor so a mid-token selection replaces the full token. */
	end: number;
}

/** Slash commands are valid only at the start of the first line. Text after the cursor does not affect the trigger. */
export function slashTokenAt(text: string, cursorOffset: number): ComposerCompletionToken | null {
	const cursor = Math.min(Math.max(cursorOffset, 0), text.length);
	const beforeCursor = text.slice(0, cursor);
	if (beforeCursor.includes("\n")) return null;
	const match = beforeCursor.match(/^\/([^\s/]*)$/);
	if (!match) return null;
	const tail = text.slice(cursor).match(/^[^\s/]*/)?.[0] ?? "";
	return { start: 0, query: match[1] ?? "", end: cursor + tail.length };
}

/** Finds the whitespace-delimited @ token around the cursor without mistaking email addresses for mentions. */
export function mentionTokenAt(text: string, cursorOffset: number): ComposerCompletionToken | null {
	const cursor = Math.min(Math.max(cursorOffset, 0), text.length);
	const match = text.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
	if (!match) return null;
	const query = match[1] ?? "";
	const tail = text.slice(cursor).match(/^[^\s@]*/)?.[0] ?? "";
	return { start: cursor - query.length - 1, query, end: cursor + tail.length };
}

/** Replaces the whole token with the completion and puts the cursor after the insertion. */
export function spliceCompletionToken(
	text: string,
	token: ComposerCompletionToken,
	insert: string,
): { text: string; cursorOffset: number } {
	return {
		text: `${text.slice(0, token.start)}${insert}${text.slice(token.end)}`,
		cursorOffset: token.start + insert.length,
	};
}
