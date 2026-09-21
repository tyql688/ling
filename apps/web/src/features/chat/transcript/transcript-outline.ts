import type { SessionMessage } from "@ling/contracts/session";
import { partsText, type TextBearingPart } from "@renderer/features/chat/transcript/message-text";
import { ANCHOR_SCROLL_MARGIN_PX } from "./transcript-scroll-policy";

/**
 * Turn outline for the transcript minimap: one entry per user message, paired with the
 * first prose reply that follows it. Ordinals count ALL user messages (same numbering as
 * the transcript's data-turn anchors), so a click can address its bubble precisely.
 */
export interface TurnOutlineEntry {
	ordinal: number;
	userText: string;
	replyText: string;
}

/**
 * Maximum characters kept in an outline/minimap hover preview. Roughly two lines of UI
 * copy; longer previews would slow down full-tree outline rebuilds during streaming deltas.
 */
const PREVIEW_CHARS = 240;
/**
 * Source-text prefix scanned to build a preview. Whitespace collapsing only shortens text,
 * so scanning 4× the target length reliably fills PREVIEW_CHARS, with per-message cost
 * independent of total reply length.
 */
const PREVIEW_SCAN_CHARS = PREVIEW_CHARS * 4;

/** The outline is navigation chrome, not a second Markdown renderer. Remove the most visible
 * syntax from its bounded preview so headings, links, tables, and emphasis read as prose. */
function plainPreviewText(text: string): string {
	return text
		.replace(/^```[^\n]*$/gm, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`+([^`]+)`+/g, "$1")
		.replace(/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/gm, " ")
		.replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
		.replace(/\[(?: |x|X)\]\s*/g, "")
		.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
		.replace(/[|*_~]+/g, " ")
		.replace(/<[^>]+>/g, " ");
}

function previewText(content: string | TextBearingPart[]): string {
	return plainPreviewText(partsText(content).slice(0, PREVIEW_SCAN_CHARS))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, PREVIEW_CHARS);
}

export function buildTurnOutline(messages: readonly SessionMessage[]): TurnOutlineEntry[] {
	const outline: TurnOutlineEntry[] = [];
	let ordinal = -1;
	for (const message of messages) {
		if (message.role === "user") {
			ordinal += 1;
			outline.push({
				ordinal,
				userText: previewText(message.content),
				replyText: "",
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		const last = outline[outline.length - 1];
		if (!last || last.replyText.length > 0) continue;
		const reply = previewText(message.content);
		if (reply.length > 0) outline[outline.length - 1] = { ...last, replyText: reply };
	}
	return outline;
}

/** Extends a frozen historical outline with a small live message suffix. The caller owns
 * the boundary: entries before `messages` must already be represented by `base`. */
export function extendTurnOutline(
	base: readonly TurnOutlineEntry[],
	messages: readonly SessionMessage[],
): readonly TurnOutlineEntry[] {
	let outline = base;
	let ordinal = base.at(-1)?.ordinal ?? -1;
	for (const message of messages) {
		if (message.role === "user") {
			ordinal += 1;
			if (outline === base) outline = [...base];
			(outline as TurnOutlineEntry[]).push({
				ordinal,
				userText: previewText(message.content),
				replyText: "",
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		const last = outline.at(-1);
		if (!last || last.replyText.length > 0) continue;
		const replyText = previewText(message.content);
		if (replyText.length === 0) continue;
		if (outline === base) outline = [...base];
		(outline as TurnOutlineEntry[])[outline.length - 1] = { ...last, replyText };
	}
	return outline;
}

/** Long sessions get evenly sampled ticks (first and last always kept) so the strip fits. */
export function sampleOutline(outline: readonly TurnOutlineEntry[], maxTicks: number): readonly TurnOutlineEntry[] {
	if (outline.length <= maxTicks || maxTicks < 2) return outline;
	const sampled: TurnOutlineEntry[] = [];
	const step = (outline.length - 1) / (maxTicks - 1);
	for (let i = 0; i < maxTicks; i += 1) {
		const entry = outline[Math.round(i * step)];
		if (entry && sampled[sampled.length - 1] !== entry) sampled.push(entry);
	}
	return sampled;
}

/**
 * Tolerance by which an anchor may pass the viewport top when deciding the "current turn".
 * Covers the bubble scroll-mt (32) plus sub-pixel error after tick jumps, avoiding highlight jitter.
 */
const CURRENT_TURN_MARGIN_PX = ANCHOR_SCROLL_MARGIN_PX + 16;

/** Scrollspy: the current tick is the LAST turn whose anchor has scrolled past the viewport
 * top. Reply lengths vary wildly, so proportional (scroll-percentage) mapping points at turns
 * the viewport isn't actually showing — only anchor positions tell the truth. Anchors that
 * aren't in the DOM come in as Infinity and can never become current. */
export function currentTickFromOffsets(offsets: number[], scrollTop: number): number {
	let current = 0;
	for (let i = 0; i < offsets.length; i += 1) {
		const offset = offsets[i];
		if (offset === undefined || offset > scrollTop + CURRENT_TURN_MARGIN_PX) break;
		current = i;
	}
	return current;
}
