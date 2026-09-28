import { useMarkdownImageUrl } from "@renderer/components/markdown-image-source";
import { HtmlBlockNode, HtmlInlineNode } from "markstream-react";
import { type ComponentProps, useMemo } from "react";

function useHtmlImageSources(content: string) {
	const resolveUrl = useMarkdownImageUrl();
	return useMemo(() => {
		// A template is inert: no image loads before its source is resolved and Markstream sanitizes the HTML.
		const template = document.createElement("template");
		template.innerHTML = content;
		const images = template.content.querySelectorAll("img");
		if (images.length === 0) return content;
		for (const image of images) {
			const url = resolveUrl(image.getAttribute("src"));
			if (url === null) image.removeAttribute("src");
			else image.setAttribute("src", url);
		}
		// Markstream escapes ampersands without first decoding entities; serialize them only once.
		return template.innerHTML.replaceAll("&amp;", "&");
	}, [content, resolveUrl]);
}

export function MarkdownHtmlBlock(props: ComponentProps<typeof HtmlBlockNode>) {
	const content = useHtmlImageSources(props.node.content);
	return <HtmlBlockNode {...props} node={{ ...props.node, content }} />;
}

export function MarkdownHtmlInline(props: ComponentProps<typeof HtmlInlineNode>) {
	const content = useHtmlImageSources(props.node.content);
	return <HtmlInlineNode {...props} node={{ ...props.node, content }} />;
}
