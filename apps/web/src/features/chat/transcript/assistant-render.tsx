import { Markdown } from "@renderer/components/markdown";
import { cn } from "@renderer/lib/utils";
import { Ansi } from "@renderer/components/ansi";
import { memo } from "react";
import { projectExtensionTerminalText } from "../extension-ui/extension-terminal-text";
import type { AssistantContentPart } from "./transcript-activity-model";

export const RenderedTerminalLines = memo(function RenderedTerminalLines({
	lines,
	inline = false,
}: {
	lines: string[];
	inline?: boolean;
}) {
	if (lines.length === 0) return null;
	const occurrences = new Map<string, number>();
	return (
		<div
			className={cn(
				"min-w-0 overflow-x-auto overscroll-contain font-mono text-xs leading-relaxed text-text-primary",
				inline ? "py-1" : "rounded-control border border-border-subtle bg-surface px-3 py-2",
			)}
		>
			{lines.map((line) => {
				const occurrence = occurrences.get(line) ?? 0;
				occurrences.set(line, occurrence + 1);
				return (
					<p key={`${line}\u0000${occurrence}`} className="whitespace-pre">
						<Ansi useClasses>{projectExtensionTerminalText(line)}</Ansi>
					</p>
				);
			})}
		</div>
	);
});

/** Markstream repairs incomplete Markdown and reveals newly streamed characters. Memoizing on
 * the two primitives keeps settled prose from re-parsing or re-animating on unrelated updates. */
export const AssistantMarkdownPart = memo(function AssistantMarkdownPart({
	text,
	streaming,
}: {
	text: string;
	streaming: boolean;
}) {
	return <Markdown text={text} streaming={streaming} />;
});

/** Caps expanded transcript disclosures such as thinking, compaction summaries, tool details and extension messages. Taller disclosures scroll in place, and `overscroll-contain` keeps wheel scrolling inside them. Assistant prose uses its full content height. */
export const EXPANDED_DETAIL_SCROLL_CLASS = "max-h-[60vh] overflow-y-auto overscroll-contain";

export function AssistantContent({
	content,
	streaming = false,
}: {
	content: AssistantContentPart[];
	streaming?: boolean;
}) {
	const caretIndex = streaming && content.at(-1)?.type === "text" ? content.length - 1 : -1;
	return (
		<div className="flex flex-col gap-2">
			{content.map((part, index) => {
				if (part.type !== "text" || part.text.trim().length === 0) return null;
				return (
					<div
						// eslint-disable-next-line react/no-array-index-key -- Pi content is append-only; keeping the slot stable avoids remounting Markstream on every streamed delta.
						key={`text:${index}`}
					>
						<AssistantMarkdownPart text={part.text} streaming={index === caretIndex} />
					</div>
				);
			})}
		</div>
	);
}
