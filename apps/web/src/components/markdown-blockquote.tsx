import { CircleAlert, Info, Lightbulb, OctagonAlert, TriangleAlert } from "lucide-react";
import { BlockquoteNode } from "markstream-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

const ALERT_ICONS = {
	note: Info,
	tip: Lightbulb,
	important: CircleAlert,
	warning: TriangleAlert,
	caution: OctagonAlert,
};

/** GitHub alerts use blockquote syntax; keep their existing Ling presentation. */
export function MarkdownBlockquote(props: ComponentProps<typeof BlockquoteNode>) {
	const { t } = useTranslation();
	const nodes = props.node.children;
	const first = nodes?.[0];
	const inline =
		first?.type === "paragraph" && Array.isArray(first.children) ? (first.children as typeof nodes) : undefined;
	const text = inline?.[0];
	const match =
		text?.type === "text" && typeof text.content === "string"
			? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.exec(text.content)
			: null;
	const marker = match?.[1];
	if (!match || !marker || !nodes || !inline || !first || text?.type !== "text" || typeof text.content !== "string")
		return <BlockquoteNode {...props} />;
	const kind = marker.toLowerCase() as keyof typeof ALERT_ICONS;
	const Icon = ALERT_ICONS[kind];
	const remaining = text.content.slice(match[0].length);
	const children = [{ ...first, children: [{ ...text, content: remaining }, ...inline.slice(1)] }, ...nodes.slice(1)];
	return (
		<div className={`markdown-alert markdown-alert-${kind}`}>
			<p className="markdown-alert-title">
				<Icon className="size-3.5 shrink-0" aria-hidden="true" />
				<span>{t(`markdown.alert${match[1]}`)}</span>
			</p>
			<BlockquoteNode {...props} node={{ ...props.node, children }} />
		</div>
	);
}
