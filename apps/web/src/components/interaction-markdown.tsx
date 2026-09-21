import { Markdown } from "./markdown";

/** Recover double-escaped paragraph/list separators in question prose, leaving code and paths literal. */
export function InteractionMarkdown({ text }: { text: string }) {
	const prose = text
		.split(/(```[\s\S]*?```|`[^`]*`)/g)
		.map((part, index) =>
			index % 2 ? part : part.replace(/(?:\\r?\\n|\\n){2,}/g, "\n\n").replace(/\\n(?=\s|[-*+#>]\s|\d+[.)]\s|$)/g, "\n"),
		)
		.join("");
	return <Markdown text={prose} className="text-ui" />;
}
