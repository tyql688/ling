import { DiffsWorkerPoolProvider } from "@renderer/components/diffs-worker-pool-provider";
import { DiffScrollRestoration, type DiffScrollPosition } from "./diff-scroll-position";
import { errorMessage } from "@ling/contracts/ling-error";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { DIFF_STYLE, type DiffCommentContext, useDiffAnnotations } from "@renderer/features/review/diff-annotations";
import { ErrorBoundary } from "@renderer/components/error-boundary";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { codeLanguage } from "@renderer/lib/code-language";
import { codeHighlightLanguage } from "@renderer/lib/code-highlighting/languages";
import { cn } from "@renderer/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prepareReviewDiff, type ReviewDiffRequest, type ReviewDiffResult } from "./review-diff-worker";

function ReviewDocument({
	scrollPosition,
	fileDiff,
	commentContext,
	diffStyle,
	expandUnchanged,
	onReady,
}: {
	fileDiff: FileDiffMetadata;
	scrollPosition?: DiffScrollPosition | undefined;
	commentContext: DiffCommentContext;
	diffStyle: "unified" | "split";
	expandUnchanged: boolean;
	onReady: () => void;
}) {
	const readyRef = useRef(false);
	const { options, annotationProps, keyboardProps } = useDiffAnnotations(fileDiff, commentContext);
	const onPostRender = useCallback(
		(node: HTMLElement, _: unknown, phase: "mount" | "update" | "unmount") => {
			if (phase !== "unmount") options.onPostRender(node);
			if (phase === "unmount" || readyRef.current) return;
			readyRef.current = true;
			onReady();
		},
		[onReady, options],
	);
	return (
		<DiffsWorkerPoolProvider>
			<div className="flex h-full min-h-0 flex-col" {...keyboardProps}>
				<Virtualizer className="min-h-0 flex-1 overflow-auto" style={DIFF_STYLE}>
					<DiffScrollRestoration position={scrollPosition} />
					<FileDiff
						// Reset Pierre's manually expanded hunks when the toolbar collapses all context.
						key={String(expandUnchanged)}
						fileDiff={fileDiff}
						options={{
							...options,
							diffStyle,
							expandUnchanged,
							overflow: "scroll",
							onPostRender,
						}}
						{...annotationProps}
						style={DIFF_STYLE}
					/>
				</Virtualizer>
			</div>
		</DiffsWorkerPoolProvider>
	);
}

export function FileDiffReview({
	scrollPosition,
	path,
	original,
	modified,
	onAddComment,
	onReady,
	diffStyle,
	expandUnchanged,
	seamless = false,
}: {
	path: string;
	scrollPosition?: DiffScrollPosition | undefined;
	original: string;
	modified: string;
	onAddComment: DiffCommentContext["onAddComment"];
	/** Publish the displayed document before the surrounding header and actions become interactive. */
	onReady: () => void;
	diffStyle: "unified" | "split";
	expandUnchanged: boolean;
	seamless?: boolean;
}) {
	const document = useMemo<ReviewDiffRequest>(
		() => ({ id: crypto.randomUUID(), path, original, modified, lang: codeHighlightLanguage(codeLanguage(path)) }),
		[path, original, modified],
	);
	const [prepared, setPrepared] = useState<{ document: ReviewDiffRequest; fileDiff: FileDiffMetadata } | null>(null);
	const [error, setError] = useState<{ document: ReviewDiffRequest; message: string } | null>(null);
	const [painted, setPainted] = useState<ReviewDiffRequest | null>(null);
	const commentContext = useMemo(() => ({ filePath: path, onAddComment }), [path, onAddComment]);
	const ready = painted === document;
	const onPainted = useCallback(() => {
		setPainted(document);
		onReady();
	}, [document, onReady]);
	useEffect(() => {
		const onResult = (result: ReviewDiffResult) => {
			if (result.status === "ok") {
				setPrepared({ document, fileDiff: result.fileDiff });
				setError(null);
			} else setError({ document, message: result.message });
		};
		try {
			return prepareReviewDiff(document, onResult);
		} catch (cause) {
			setError({ document, message: errorMessage(cause) });
		}
	}, [document]);
	return (
		<div
			className={cn(
				"relative flex h-full min-h-0 flex-col overflow-hidden",
				!seamless && "rounded-control border border-border-subtle",
			)}
			aria-busy={!ready && error?.document !== document}
		>
			{error?.document === document && (
				<FeedbackNotice tone="danger" className="shrink-0 text-xs">
					{error.message}
				</FeedbackNotice>
			)}
			<div className="min-h-0 flex-1" inert={!ready}>
				<ErrorBoundary
					resetKeys={[document]}
					fallback={(cause) => <FeedbackNotice tone="danger">{cause.message}</FeedbackNotice>}
				>
					{prepared !== null && (
						<ReviewDocument
							key={prepared.document.id}
							fileDiff={prepared.fileDiff}
							scrollPosition={scrollPosition}
							commentContext={commentContext}
							diffStyle={diffStyle}
							expandUnchanged={expandUnchanged}
							onReady={prepared.document === document ? onPainted : () => undefined}
						/>
					)}
				</ErrorBoundary>
			</div>
		</div>
	);
}
