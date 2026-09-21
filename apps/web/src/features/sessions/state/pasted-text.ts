import type { PastedTextBlock } from "@ling/contracts/draft";

/**
 * Minimum paste length that gets collapsed into a draft block. Roughly 4k chars ≈ two
 * screens of body text in the composer's 30vh; shorter pastes are easier to edit inline,
 * longer ones would dominate the editor and its undo history.
 */
export const PASTED_TEXT_BLOCK_MIN_CHARS = 4_000;

/** Opening tag of a pasted block sent to the model; paired with the close tag so the model can tell pasted material from the typed ask. */
const BLOCK_OPEN = "<pasted-text>";
/** Closing tag of a pasted block. */
const BLOCK_CLOSE = "</pasted-text>";
/** Separator between the typed body and pasted blocks, and between blocks. */
const SEPARATOR = "\n\n";

/** Wire form of one block: tagged so the model can tell pasted material from the typed ask. */
function renderBlock(block: PastedTextBlock): string {
	return `${BLOCK_OPEN}\n${block.text}\n${BLOCK_CLOSE}`;
}

/** Final message text: the typed message first, then each pasted block in paste order.
 * Returns null when there is nothing to send at all. */
export function mergePastedBlocks(submitted: string | null, blocks: readonly PastedTextBlock[]): string | null {
	const parts = [...(submitted === null ? [] : [submitted]), ...blocks.map(renderBlock)];
	return parts.length === 0 ? null : parts.join(SEPARATOR);
}

/** Chars the merged message will occupy — used to gate a paste BEFORE accepting it, so a
 * paste that cannot ever be sent falls through to the editor's existing bounded-input
 * feedback instead of silently creating an unsendable block. */
export function mergedPastedLength(textLength: number, blocks: readonly PastedTextBlock[], nextBlockLength: number) {
	const blockLengths = [...blocks.map((block) => block.text.length), nextBlockLength];
	const wrapped = blockLengths.reduce(
		(total, length) => total + length + BLOCK_OPEN.length + BLOCK_CLOSE.length + 2, // 2 = block-internal newlines
		0,
	);
	const separators = (blockLengths.length + (textLength > 0 ? 1 : 0) - 1) * SEPARATOR.length;
	return textLength + wrapped + Math.max(0, separators);
}
