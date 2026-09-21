import { MarkdownCode, MarkdownCodeProvider, MarkdownInlineCode } from "@renderer/components/markdown-code-block";
import { MarkdownBlockquote } from "@renderer/components/markdown-blockquote";
import { MarkdownTable } from "@renderer/components/markdown-table";
import { MarkdownExternalLinkDialog } from "@renderer/components/markdown-external-link";
import { MarkdownDocumentContext } from "./markdown-image-root";
import { MarkdownImage } from "@renderer/components/markdown-image";
import { useStreamingText } from "@renderer/hooks/use-streaming-text";
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
	blockquote: MarkdownBlockquote,
	table: MarkdownTable,
	code_block: MarkdownCode,
	inline_code: MarkdownInlineCode,
	mermaid: MarkdownCode,
	// These languages remain code until Ling deliberately exposes their preview features.
	d2: MarkdownCode,
	d2lang: MarkdownCode,
	infographic: MarkdownCode,
});

const configureMarkdown: NonNullable<NodeRendererProps["customMarkdownIt"]> = (parser) => {
	// Astryx exposes named inline rules; Markstream's narrowed MarkdownIt type omits them.
	// Wrap only image normalization so file links and literal code keep their original URLs.
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
	// Keep emoji aliases without turning ordinary punctuation into emoticons.
	return parser.use(emoji, { shortcuts: {} });
};

interface MarkdownProps {
	text: string;
	className?: string;
	streaming?: boolean;
	showLineNumbers?: boolean;
	/** Thinking already owns a shared cursor for its collapsed and expanded presentations. */
	smooth?: boolean;
}

function MarkdownView({ text, className, streaming = false, showLineNumbers = false, smooth = true }: MarkdownProps) {
	const output = useStreamingText(text, streaming, smooth);
	const { appearance } = useAtomValue(activeSkinAppearanceAtom);
	const id = useId();
	const document = useContext(MarkdownDocumentContext);
	const [externalUrl, setExternalUrl] = useState<string | null>(null);
	const onClick = (event: MouseEvent<HTMLElement>) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const link = target.closest("a[href]");
		if (!(link instanceof HTMLAnchorElement)) return;
		const href = link.getAttribute("href");
		if (href === null) return;
		event.preventDefault();
		if (href.startsWith("#")) {
			event.currentTarget.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({ block: "nearest" });
			return;
		}
		const path = document?.resolve(href);
		if (path !== null && path !== undefined) {
			document?.open(path);
			return;
		}
		setExternalUrl(href);
	};
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
					batchRendering={false}
					viewportPriority={false}
					deferNodesUntilVisible={false}
					renderCodeBlocksAsPre
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
