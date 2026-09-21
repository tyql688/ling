import { DiffsWorkerPoolProvider } from "@renderer/components/diffs-worker-pool-provider";
import { DiffScrollRestoration, type DiffScrollPosition } from "./diff-scroll-position";
import { errorMessage } from "@ling/contracts/ling-error";
import { getFiletypeFromFileName, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { File, FileDiff, PatchDiff, Virtualizer } from "@pierre/diffs/react";
import { DIFF_STYLE, type DiffCommentContext, useDiffAnnotations } from "@renderer/features/review/diff-annotations";
import { ErrorBoundary } from "@renderer/components/error-boundary";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useCopyFeedback } from "@renderer/hooks/use-copy-feedback";
import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { codeLanguage } from "@renderer/lib/code-language";
import { codeHighlightLanguage } from "@renderer/lib/code-highlighting/languages";
import { CODE_THEME_PAIRS } from "@renderer/lib/preferences/code-preview";
import { cn } from "@renderer/lib/utils";
import { useAtomValue } from "jotai";
import { Check, Copy, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface DiffViewProps {
	scrollPosition?: DiffScrollPosition | undefined;
	diff: string;
	commentContext?: DiffCommentContext;
	fillAvailableHeight?: boolean;
	showFilename?: boolean;
	diffStyle?: "unified" | "split";
	onLoadContext?: (() => void) | undefined;
	seamless?: boolean;
}

function PatchFile({
	patch,
	file,
	commentContext,
	diffStyle,
	onLoadContext,
}: {
	patch: string | null;
	file: FileDiffMetadata;
	commentContext: DiffCommentContext | undefined;
	diffStyle: "unified" | "split";
	onLoadContext: (() => void) | undefined;
}) {
	const { options, annotationProps, keyboardProps } = useDiffAnnotations(file, commentContext, onLoadContext);
	const props = {
		...annotationProps,
		options: { ...options, diffStyle, overflow: "wrap" as const },
		style: DIFF_STYLE,
	};
	// PatchDiff infers grammar from the filename. FileDiff also lets us select plain text
	// for unsupported languages, and render individual files from a multi-file patch.
	return (
		<div {...keyboardProps}>
			{patch === null ? <FileDiff fileDiff={file} {...props} /> : <PatchDiff patch={patch} {...props} />}
		</div>
	);
}

function PatchBody({
	diff,
	commentContext,
	showFilename,
	diffStyle,
	onLoadContext,
}: Pick<DiffViewProps, "diff" | "commentContext" | "showFilename" | "diffStyle" | "onLoadContext"> & {
	diffStyle: "unified" | "split";
}) {
	const { t } = useTranslation();
	const filePath = commentContext?.filePath;
	const parsed = useMemo(() => {
		// Pi edit results carry their own line numbers and have no hunk headers. They remain
		// diff-colored source text; inventing unified coordinates would produce wrong comments.
		if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(diff)) return null;
		const hasFileHeader = /^diff --git |^--- .+\r?\n\+\+\+ /m.test(diff);
		const language = filePath === undefined ? "text" : codeHighlightLanguage(codeLanguage(filePath));
		// Host turn/untracked previews can legitimately contain hunks without file headers.
		const patch = hasFileHeader ? diff : `--- preview.${language}\n+++ preview.${language}\n${diff}`;
		const files = parsePatchFiles(patch, crypto.randomUUID(), true)
			.flatMap((entry) => entry.files)
			.map((file) => ({ ...file, lang: codeHighlightLanguage(getFiletypeFromFileName(file.name)) }));
		if (files.length === 0) throw new Error("Diff contains no readable file hunks");
		return { patch, hasFileHeader, files };
	}, [filePath, diff]);
	const appearance = useAtomValue(activeSkinAppearanceAtom);
	const rawFile = useMemo(() => ({ name: "preview.diff", contents: diff, lang: "diff" }), [diff]);
	if (parsed === null) {
		return (
			<File
				file={rawFile}
				options={{
					theme: CODE_THEME_PAIRS[appearance.codeTheme],
					themeType: appearance.appearance,
					disableFileHeader: true,
					disableLineNumbers: true,
					overflow: "wrap",
				}}
				style={DIFF_STYLE}
			/>
		);
	}
	return parsed.files.map((file) => {
		const language = getFiletypeFromFileName(file.name);
		const previousLanguage = file.prevName === undefined ? language : getFiletypeFromFileName(file.prevName);
		const supported = file.lang === language && codeHighlightLanguage(previousLanguage) === previousLanguage;
		return (
			<div key={file.cacheKey}>
				{onLoadContext === undefined && file.isPartial && file.hunks.some((hunk) => hunk.collapsedBefore > 0) && (
					<p className="px-3 py-2 text-xs text-text-muted">{t("changes.diffContextUnavailable")}</p>
				)}
				{showFilename && parsed.hasFileHeader && (
					<div className="flex items-center gap-1.5 border-code-block-border border-b px-2.5 py-1.5 font-mono text-xs text-text-muted">
						<FileText className="size-3.5 shrink-0" aria-hidden="true" />
						<span className="truncate">{file.name}</span>
					</div>
				)}
				<PatchFile
					patch={parsed.files.length === 1 && supported ? parsed.patch : null}
					file={file}
					commentContext={commentContext}
					diffStyle={diffStyle}
					onLoadContext={onLoadContext}
				/>
			</div>
		);
	});
}

/** Pierre owns parsing, syntax, coordinates and virtual rows; Ling owns actions and comment drafts. */
export function DiffView({
	scrollPosition,
	diff,
	commentContext,
	fillAvailableHeight = false,
	showFilename = true,
	diffStyle = "unified",
	onLoadContext,
	seamless = false,
}: DiffViewProps) {
	const { t } = useTranslation();
	const { copiedKey, markCopied, clearCopied } = useCopyFeedback<string>();
	const [copyError, setCopyError] = useState<{ diff: string; message: string } | null>(null);
	const copyDiff = async () => {
		try {
			await navigator.clipboard.writeText(diff);
			setCopyError(null);
			markCopied(diff);
		} catch (cause) {
			clearCopied();
			setCopyError({ diff, message: errorMessage(cause) });
		}
	};
	return (
		<div
			className={cn(
				"overflow-hidden",
				!seamless &&
					"rounded-panel border border-code-block-border bg-code-block shadow-[var(--shadow-reading-surface)]",
				fillAvailableHeight && "flex h-full min-h-0 flex-col",
			)}
		>
			<ErrorBoundary
				resetKeys={[diff]}
				fallback={(error) => (
					<>
						<FeedbackNotice tone="danger">{error.message}</FeedbackNotice>
						<pre className="max-h-96 overflow-auto whitespace-pre-wrap p-2 text-xs">{diff}</pre>
					</>
				)}
			>
				<DiffsWorkerPoolProvider>
					<Virtualizer
						className={cn("overflow-auto", fillAvailableHeight ? "min-h-0 flex-1" : "max-h-96")}
						contentClassName="min-w-0"
						style={DIFF_STYLE}
					>
						<DiffScrollRestoration position={scrollPosition} />
						<PatchBody
							diff={diff}
							showFilename={showFilename}
							diffStyle={diffStyle}
							onLoadContext={onLoadContext}
							{...(commentContext === undefined ? {} : { commentContext })}
						/>
					</Virtualizer>
				</DiffsWorkerPoolProvider>
			</ErrorBoundary>
			<div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-code-block-border border-t px-2 py-1 text-xs text-text-muted">
				<button
					type="button"
					onClick={() => void copyDiff()}
					className="inline-flex items-center gap-1 rounded-sm px-2 py-1 hover:bg-surface-hover"
				>
					{copiedKey === diff ? (
						<Check className="size-3.5" aria-hidden="true" />
					) : (
						<Copy className="size-3.5" aria-hidden="true" />
					)}
					{t(copiedKey === diff ? "session.copied" : "session.diffCopy")}
				</button>
				{copyError?.diff === diff && (
					<p role="alert" className="w-full text-danger">
						{t("session.diffCopyFailed", { message: copyError.message })}
					</p>
				)}
			</div>
		</div>
	);
}
