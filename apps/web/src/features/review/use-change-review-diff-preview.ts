import { useDomainApi } from "@renderer/lib/host-api-context";
import {
	type CancelChangeReviewDiffRequest,
	type ChangeReviewDiffResponse,
	type ChangeReviewScope,
	type ChangeReviewSnapshot,
	CHANGE_REVIEW_DIFF_CONTEXT_MAX_LINES,
} from "@ling/contracts/git";
import { CHANGE_REVIEW_DIFF_OWNER_ID, createBuiltinOperationRef } from "@ling/contracts/owner-ref";
import { previewMediaKind } from "@ling/contracts/preview-media";
import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { formatRequestError, isExpectedCancellation } from "@renderer/lib/errors";
import { useEffect, useState } from "react";

/** Request deadline for review generation (including diff computation). */
const REVIEW_REQUEST_DEADLINE_MS = 30_000;
/** Git's default unified context; the first expansion matches Pierre's default, then each fetch adds 100 lines. */
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const DIFF_CONTEXT_EXPANSION_LINES = 100;
export type PreviewState =
	| ({ key: string; owner: string; path: string } & (
			| {
					kind: "diff";
					text: string;
					editor: ChangeReviewDiffResponse["editor"];
			  }
			| { kind: "media" }
			| { kind: "empty" }
	  ))
	| null;

/**
 * Diff preview fetch for the selected review file: operation-scoped, cancelled on
 * selection/scope change, with expandable context lines keyed to the current preview.
 */
export function useChangeReviewDiffPreview({
	open,
	sessionRef,
	snapshot,
	scope,
	/** Historical turn id while scope === "turn" and a specific turn is selected; null on the live view. */
	historicalTurnId,
	selectedPath,
}: {
	open: boolean;
	sessionRef: SessionRef;
	snapshot: ChangeReviewSnapshot | null;
	scope: ChangeReviewScope;
	historicalTurnId: string | null;
	selectedPath: string | null;
}) {
	const hostChangeReviewApi = useDomainApi("changeReview");

	const [preview, setPreview] = useState<PreviewState>(null);
	const [request, setRequest] = useState<{ key: string; pending: boolean; error: string | null } | null>(null);
	const [diffContext, setDiffContext] = useState<{ key: string; lines: number } | null>(null);

	const owner = [sessionKey(sessionRef), scope, historicalTurnId ?? ""].join("\u0000");
	const previewKey =
		snapshot && selectedPath !== null ? [owner, snapshot.snapshotId, selectedPath].join("\u0000") : null;
	const contextLines =
		diffContext !== null && diffContext.key === previewKey ? diffContext.lines : DEFAULT_DIFF_CONTEXT_LINES;
	const requestKey = previewKey === null ? null : `${previewKey}\u0000${contextLines}`;
	const loadingPreview = open && requestKey !== null && (request?.key !== requestKey || request.pending);
	const previewError = request?.key === requestKey ? request.error : null;
	// Keep the last diff visible during a file switch, fenced to this session and review scope.
	// Its own path travels with the content; the detail pane blocks actions until the new result arrives.
	const visiblePreview =
		open &&
		(preview?.key === previewKey ||
			(loadingPreview &&
				preview?.owner === owner &&
				preview.kind === "diff" &&
				selectedPath !== null &&
				previewMediaKind(selectedPath) === null))
			? preview
			: null;
	const canExpandDiffContext =
		previewKey !== null &&
		snapshot?.isRepository === true &&
		scope !== "turn" &&
		contextLines < CHANGE_REVIEW_DIFF_CONTEXT_MAX_LINES;

	useEffect(() => {
		if (!open || !snapshot || selectedPath === null || previewKey === null || requestKey === null) {
			setPreview(null);
			setRequest(null);
			return;
		}
		// A picture has no text diff worth fetching: Git answers either a one-line "binary files
		// differ" or a base85 patch body, and neither is something to read. The pane draws the
		// versions themselves instead, straight from the protocol.
		if (previewMediaKind(selectedPath) !== null) {
			setPreview({ key: previewKey, owner, path: selectedPath, kind: "media" });
			setRequest({ key: requestKey, pending: false, error: null });
			return;
		}
		let cancelled = false;
		const operation = createBuiltinOperationRef(crypto.randomUUID(), CHANGE_REVIEW_DIFF_OWNER_ID, {
			scope: { kind: "session", ref: sessionRef },
			revision: snapshot.snapshotId,
			generation: 0,
		});
		const cancellation: CancelChangeReviewDiffRequest = {
			operation,
			ref: sessionRef,
			snapshotId: snapshot.snapshotId,
		};
		const loadPreview = async () => {
			setRequest({ key: requestKey, pending: true, error: null });
			const setPreviewError = (error: string): void => setRequest({ key: requestKey, pending: false, error });
			try {
				const result = await hostChangeReviewApi.getDiff({
					operation,
					ref: sessionRef,
					snapshotId: snapshot.snapshotId,
					deadlineAt: Date.now() + REVIEW_REQUEST_DEADLINE_MS,
					scope,
					path: selectedPath,
					...(contextLines > DEFAULT_DIFF_CONTEXT_LINES ? { contextLines } : {}),
					...(historicalTurnId !== null ? { turnId: historicalTurnId } : {}),
				});
				if (cancelled) return;
				if (result.requestId !== operation.requestId) {
					setPreviewError("Ling returned a mismatched change review response.");
					return;
				}
				const diff = result.diff;
				if (diff.trim().length > 0) {
					setPreview({
						key: previewKey,
						owner,
						path: selectedPath,
						kind: "diff",
						text: diff,
						editor: result.editor,
					});
				} else setPreview({ key: previewKey, owner, path: selectedPath, kind: "empty" });
			} catch (cause) {
				if (!cancelled && !isExpectedCancellation(cause)) setPreviewError(formatRequestError(cause));
			} finally {
				if (!cancelled)
					setRequest((current) => (current?.key === requestKey ? { ...current, pending: false } : current));
			}
		};
		void loadPreview();
		return () => {
			cancelled = true;
			void hostChangeReviewApi.cancelDiff(cancellation).catch((cause: unknown) => {
				if (!isExpectedCancellation(cause))
					console.error("Failed to cancel abandoned change review diff", formatRequestError(cause));
			});
		};
	}, [
		hostChangeReviewApi,
		contextLines,
		open,
		owner,
		previewKey,
		requestKey,
		historicalTurnId,
		sessionRef,
		snapshot,
		scope,
		selectedPath,
	]);

	const expandDiffContext = (): void => {
		if (!canExpandDiffContext || previewKey === null) return;
		setDiffContext({
			key: previewKey,
			lines: Math.min(contextLines + DIFF_CONTEXT_EXPANSION_LINES, CHANGE_REVIEW_DIFF_CONTEXT_MAX_LINES),
		});
	};

	return { visiblePreview, previewError, loadingPreview, canExpandDiffContext, expandDiffContext };
}
