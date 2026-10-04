import { MarkdownCode, MarkdownCodeProvider, MarkdownInlineCode } from "@renderer/components/markdown-code-block";
import { MarkdownBlockquote } from "@renderer/components/markdown-blockquote";
import { MarkdownTable } from "@renderer/components/markdown-table";
import { MarkdownExternalLinkDialog } from "@renderer/components/markdown-external-link";
import { MarkdownDocumentContext } from "./markdown-image-root";
import { MarkdownImage } from "@renderer/components/markdown-image";
import { MarkdownHtmlBlock, MarkdownHtmlInline } from "@renderer/components/markdown-html";
import { useStreamingText } from "@renderer/hooks/use-streaming-text";
import { useStableCallback } from "@renderer/hooks/use-stable-callback";
import { cn } from "@renderer/lib/utils";
import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { useAtomValue } from "jotai";
import { full as emoji } from "markdown-it-emoji";
import MarkdownRender, { type ImageNode, setCustomComponents, type NodeRendererProps } from "markstream-react";
import "markstream-react/index.css";
import "katex/dist/katex.min.css";
import { type ComponentProps, memo, useContext, type MouseEvent, useId, useState } from "react";

/** One module-scoped registration is shared by all Markdown surfaces for the app lifetime. */
const MARKDOWN_COMPONENT_SCOPE = "ling";

function MarkdownImageNode({ node }: ComponentProps<typeof ImageNode>) {
	return <MarkdownImage src={node.src} alt={node.alt} title={node.title ?? undefined} />;
}

setCustomComponents(MARKDOWN_COMPONENT_SCOPE, {
	image: MarkdownImageNode,
	html_block: MarkdownHtmlBlock,
	html_inline: MarkdownHtmlInline,
	blockquote: MarkdownBlockquote,
	table: MarkdownTable,
	code_block: MarkdownCode,
	inline_code: MarkdownInlineCode,
	mermaid: MarkdownCode,
	// Render these languages as code until Ling provides a preview for them.
	d2: MarkdownCode,
	d2lang: MarkdownCode,
	infographic: MarkdownCode,
});

const configureMarkdown: NonNullable<NodeRendererProps["customMarkdownIt"]> = (parser) => {
	// Astryx exposes named inline rules; Markstream's narrowed MarkdownIt type omits them.
	// Normalize image URLs through this wrapper. File links and literal code use their authored URLs.
	type ImageState = { md: { normalizeLink: (url: string) => string } };
	const ruler = parser.inline.ruler as typeof parser.inline.ruler & {
		getNamedRules(): { name: string; fn(state: ImageState, silent: boolean): unknown }[];
	};
	const imageRule = ruler.getNamedRules().find((rule) => rule.name === "image");
	if (!imageRule) throw new Error("The Markdown parser has no image rule.");
	ruler.at("image", (state: ImageState, silent: boolean) => {
		const normalizeLink = state.md.normalizeLink;
		// Ling validates the absolute project path and replaces it with an authenticated URL.
		state.md.normalizeLink = (url) => normalizeLink(url.startsWith("file://") ? url.slice("file://".length) : url);
		try {
			return imageRule.fn(state, silent);
		} finally {
			state.md.normalizeLink = normalizeLink;
		}
	});
	parser.core.ruler.push("ling_heading_ids", (state) => {
		const used = new Set<string>();
		for (let index = 0; index < state.tokens.length; index++) {
			const heading = state.tokens[index];
			const inline = state.tokens[index + 1];
			if (heading?.type !== "heading_open" || inline?.type !== "inline") continue;
			const children: Array<{ type: string; content: string }> = inline.children ?? [];
			const text = children
				.filter((token) => ["text", "code_inline", "emoji", "image"].includes(token.type))
				.map((token) => token.content)
				.join("");
			const base = text
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
				.replace(/\s/g, "-");
			let id = base;
			for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`;
			used.add(id);
			heading.attrSet("id", id);
		}
	});
	// Expand emoji aliases and keep ordinary punctuation literal.
	return parser.use(emoji, { shortcuts: {} });
};

interface MarkdownProps {
	text: string;
	className?: string;
	streaming?: boolean;
	showLineNumbers?: boolean;
	/** Thinking already owns a shared cursor for its collapsed and expanded presentations. */
	smooth?: boolean;
	/** Yield document rendering between batches so the workbench remains responsive. */
	progressive?: boolean;
}

function MarkdownView({
	text,
	className,
	streaming = false,
	showLineNumbers = false,
	smooth = true,
	progressive = false,
}: MarkdownProps) {
	const output = useStreamingText(text, streaming, smooth);
	const { appearance } = useAtomValue(activeSkinAppearanceAtom);
	const id = useId();
	const document = useContext(MarkdownDocumentContext);
	const [externalUrl, setExternalUrl] = useState<string | null>(null);
	const onClick = useStableCallback((event: MouseEvent<HTMLElement>) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const link = target.closest("a[href]");
		if (!(link instanceof HTMLAnchorElement)) return;
		const href = link.getAttribute("href");
		if (href === null) return;
		event.preventDefault();
		if (href.startsWith("#")) {
			let fragment = href.slice(1);
			try {
				fragment = decodeURIComponent(fragment);
			} catch {
				// A literal percent sign is valid in an explicitly authored HTML id.
			}
			const target = fragment ? event.currentTarget.querySelector(`#${CSS.escape(fragment)}`) : event.currentTarget;
			target?.scrollIntoView({ block: "nearest" });
			return;
		}
		const path = document?.resolve(href);
		if (path !== null && path !== undefined) {
			document?.open(path);
			return;
		}
		setExternalUrl(href);
	});
	return (
		<div
			className={cn("chat-markdown text-text-primary", className)}
			data-md-streaming={output.streaming ? "true" : undefined}
		>
			<MarkdownCodeProvider showLineNumbers={showLineNumbers} streaming={output.streaming}>
				<MarkdownRender
					content={output.text}
					final={!output.streaming}
					customId={MARKDOWN_COMPONENT_SCOPE}
					indexKey={id}
					isDark={appearance === "dark"}
					customMarkdownIt={configureMarkdown}
					htmlPolicy="safe"
					smoothStreaming={false}
					fade={output.streaming && output.animate}
					typewriter={false}
					batchRendering={progressive}
					// Short batches leave room for input and layout in table- and code-heavy documents.
					renderBatchSize={48}
					renderBatchIdleTimeoutMs={32}
					// Ling owns scroll geometry; parsed nodes stay addressable across the full document.
					maxLiveNodes={0}
					viewportPriority={false}
					deferNodesUntilVisible={false}
					renderCodeBlocksAsPre
					// Native link titles stay scoped to their anchors when a document is replaced.
					showTooltips={false}
					onClick={onClick}
				/>
			</MarkdownCodeProvider>
			{externalUrl !== null && (
				<MarkdownExternalLinkDialog key={externalUrl} url={externalUrl} onClose={() => setExternalUrl(null)} />
			)}
		</div>
	);
}

/** Preserve completed Markdown trees while other sessions and timeline rows update. */
export const Markdown = memo(MarkdownView);
