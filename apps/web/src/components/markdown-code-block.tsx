import { HighlightedMarkdownCode } from "@renderer/components/highlighted-markdown-code";
import { useMarkdownFileMentions } from "@renderer/components/markdown-file-mentions";
import { MarkdownMermaidBlock } from "@renderer/components/markdown-mermaid-block";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { COPY_FEEDBACK_MS } from "@renderer/hooks/use-copy-feedback";
import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { codeHighlightLanguage } from "@renderer/lib/code-highlighting/languages";
import { formatRequestError } from "@renderer/lib/errors";
import { canRenderMermaid } from "@renderer/lib/mermaid-guard";
import { CODE_PREVIEW_DEFAULTS, CODE_THEME_PAIRS } from "@renderer/lib/preferences/code-preview";
import { cn } from "@renderer/lib/utils";
import { useAtomValue } from "jotai";
import { Check, CircleAlert, Copy, TextWrap } from "lucide-react";
import type { NodeComponentProps } from "markstream-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface MarkdownCodeContextValue {
	showLineNumbers: boolean;
	streaming: boolean;
}

const MarkdownCodeContext = createContext<MarkdownCodeContextValue | null>(null);

function useMarkdownCodeContext(): MarkdownCodeContextValue {
	const value = useContext(MarkdownCodeContext);
	if (!value) throw new Error("Markdown code renderer must be nested under MarkdownCodeProvider");
	return value;
}

export function MarkdownCodeProvider({
	children,
	showLineNumbers,
	streaming,
}: {
	children: ReactNode;
	showLineNumbers: boolean;
	streaming: boolean;
}) {
	const value = useMemo(() => ({ showLineNumbers, streaming }), [showLineNumbers, streaming]);
	return <MarkdownCodeContext.Provider value={value}>{children}</MarkdownCodeContext.Provider>;
}

function trimTrailingNewlines(code: string): string {
	let end = code.length;
	while (end > 0 && code.charCodeAt(end - 1) === 10) end -= 1;
	return code.slice(0, end);
}

function CodeAction({
	label,
	pressed,
	failed = false,
	onClick,
	children,
}: {
	label: string;
	pressed?: boolean;
	failed?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	const button = (
		<button
			type="button"
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-control border border-transparent",
				"bg-transparent text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary",
				pressed && "bg-surface-hover",
				failed && "text-danger",
			)}
			aria-label={label}
			onClick={onClick}
			{...(pressed === undefined ? {} : { "aria-pressed": pressed })}
		>
			{children}
		</button>
	);
	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function PlainCode({ code, wrapLongLines, streaming }: { code: string; wrapLongLines: boolean; streaming: boolean }) {
	// Concrete px/stack, consistent with the Pierre path, so code renders identically outside the CSS-variable scope.
	const { fontFamily, fontSizePx } = CODE_PREVIEW_DEFAULTS;
	return (
		<pre
			data-streaming-code={streaming ? "true" : undefined}
			className={cn(
				"m-0 block max-w-full overflow-auto bg-transparent px-[1ch] font-normal text-text-primary",
				wrapLongLines ? "whitespace-pre-wrap break-words" : "whitespace-pre",
			)}
			style={{
				fontFamily,
				fontSize: `${fontSizePx}px`,
				lineHeight: `${fontSizePx + 8}px`,
				tabSize: 2,
			}}
		>
			<code className={cn("block bg-transparent", wrapLongLines ? "min-w-0" : "min-w-max")}>{code}</code>
		</pre>
	);
}

function CodeBlock({ code, language }: { code: string; language: string }) {
	const { showLineNumbers, streaming } = useMarkdownCodeContext();
	const activeAppearance = useAtomValue(activeSkinAppearanceAtom);
	const codeTheme = CODE_THEME_PAIRS[activeAppearance.codeTheme];
	const { t } = useTranslation();
	const [wrapLongLines, setWrapLongLines] = useState(CODE_PREVIEW_DEFAULTS.wrapLongLines);
	const [copied, setCopied] = useState(false);
	const [copyFailure, setCopyFailure] = useState<string | null>(null);
	const copyTimer = useRef(0);

	useEffect(
		() => () => {
			window.clearTimeout(copyTimer.current);
		},
		[],
	);

	const resetCopyFeedbackLater = useCallback(() => {
		window.clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => {
			setCopied(false);
			setCopyFailure(null);
		}, COPY_FEEDBACK_MS);
	}, []);
	const reportCopyFailure = useCallback(
		(error: unknown) => {
			console.error("Failed to copy code", error);
			setCopied(false);
			setCopyFailure(formatRequestError(error, t));
			resetCopyFeedbackLater();
		},
		[resetCopyFeedbackLater, t],
	);
	const copyCode = useCallback(async () => {
		if (copied) return;
		const clipboard = navigator.clipboard;
		if (!clipboard || typeof clipboard.writeText !== "function") {
			reportCopyFailure(new Error(t("markdown.clipboardUnavailable")));
			return;
		}
		try {
			await clipboard.writeText(code);
			setCopied(true);
			setCopyFailure(null);
			resetCopyFeedbackLater();
		} catch (error) {
			reportCopyFailure(error);
		}
	}, [code, copied, reportCopyFailure, resetCopyFeedbackLater, t]);

	const wrapLabel = t("settings.wrapLongCodeLines");
	const copyLabel = copied
		? t("markdown.copied")
		: copyFailure
			? `${t("markdown.copyCodeFailed")}: ${copyFailure}`
			: t("markdown.copyCode");

	return (
		// Do NOT use content-visibility here: it reserved ~200px while Pierre's
		// diffs-container stayed height 0 (CDP: empty shadow, no code text).
		<div
			className="md-code-block group relative my-0.5 w-full overflow-hidden rounded-control bg-code-block text-text-primary"
			data-language={language}
		>
			<div className="flex items-center justify-between gap-3 px-3 py-1.5 pr-2 text-sm text-text-muted">
				<span className="truncate font-mono text-xs lowercase">{language}</span>
				<div className="-my-1 -mr-1 flex items-center gap-1">
					<CodeAction label={wrapLabel} pressed={wrapLongLines} onClick={() => setWrapLongLines((value) => !value)}>
						<TextWrap className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
					</CodeAction>
					<CodeAction label={copyLabel} failed={copyFailure !== null} onClick={() => void copyCode()}>
						{copyFailure ? (
							<CircleAlert className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
						) : copied ? (
							<Check className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
						) : (
							<Copy className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
						)}
					</CodeAction>
				</div>
			</div>
			<div className="min-w-0 p-2 pb-3">
				{/*
				 * The highlighted path must mount Pierre synchronously so its first paint keeps the final geometry.
				 * Font family/size go through CSS variables; only theme/line-number changes need a React update.
				 */}
				{streaming || (!showLineNumbers && codeHighlightLanguage(language) === "text") ? (
					// Plain text has no grammar to load. Keep it out of the shared highlighter and AST cache.
					<PlainCode code={code} wrapLongLines={wrapLongLines} streaming={streaming} />
				) : (
					<HighlightedMarkdownCode
						code={code}
						language={language}
						showLineNumbers={showLineNumbers}
						theme={codeTheme}
						wrapLongLines={wrapLongLines}
					/>
				)}
			</div>
		</div>
	);
}

/** A resolved file keeps its inline-code chip and gains the skin's link ink and focus state. */
function FileMentionLink({
	path,
	onOpen,
	children,
}: {
	path: string;
	onOpen: (path: string) => void;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			className="md-file-mention"
			title={path}
			aria-label={t("changes.openFileMention", { path })}
			onClick={() => onOpen(path)}
		>
			{children}
		</button>
	);
}

export function MarkdownInlineCode({ node }: NodeComponentProps<{ code: string }>) {
	const { streaming } = useMarkdownCodeContext();
	const mentions = useMarkdownFileMentions();
	const chip = <code className="md-inline-code">{node.code}</code>;
	// A half-written token must not resolve as a different workspace file.
	if (mentions === null || streaming) return chip;
	const path = mentions.resolve(node.code);
	return path === null ? (
		chip
	) : (
		<FileMentionLink path={path} onOpen={mentions.open}>
			{chip}
		</FileMentionLink>
	);
}

export function MarkdownCode({ node }: NodeComponentProps<{ code: string; language?: string }>) {
	const { streaming } = useMarkdownCodeContext();
	const { t } = useTranslation();
	// A fence without a language is plain text, as in CommonMark.
	const language = node.language?.trim().toLowerCase() || "text";
	const code = trimTrailingNewlines(node.code);
	// Mount the preview frame immediately so a code-sized Suspense fallback cannot move
	// the transcript later. MermaidBlockNode still loads the diagram engine on demand.
	if (language === "mermaid" && !streaming) {
		if (canRenderMermaid(code)) return <MarkdownMermaidBlock code={code} />;
		return (
			<div className="flex min-w-0 flex-col gap-2">
				<FeedbackNotice tone="warning">{t("markdown.diagramTooLarge")}</FeedbackNotice>
				<CodeBlock code={code} language={language} />
			</div>
		);
	}
	return <CodeBlock code={code} language={language} />;
}
