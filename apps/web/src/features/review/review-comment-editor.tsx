import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { REVIEW_COMMENT_TEXT_MAX_CHARS, type ReviewCommentIssue } from "@ling/contracts/draft-review-comments";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Shared comment composer for patch and full-file diff annotations. A successful submit transfers the
 * comment to the session composer; validation failures remain visible in place. */
export function ReviewCommentEditor({
	rangeLabel,
	onSubmit,
	onCancel,
}: {
	rangeLabel: string;
	onSubmit: (text: string) => ReviewCommentIssue | null;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState("");
	const [issue, setIssue] = useState<ReviewCommentIssue | null>(null);
	const trimmed = text.trim();
	useEffect(() => {
		// Pierre positions annotation slots after React commits. Focus after that placement so
		// the originating pointer event cannot move focus back to the diff's keyboard surface.
		const frame = requestAnimationFrame(() => textareaRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);
	const submit = () => {
		if (trimmed.length === 0) return;
		setIssue(onSubmit(trimmed));
	};
	const issueMessage =
		issue === "count"
			? t("changes.commentLimitCount")
			: issue === "text"
				? t("changes.commentLimitText", { count: REVIEW_COMMENT_TEXT_MAX_CHARS })
				: issue === "size"
					? t("changes.commentLimitSize")
					: null;
	return (
		<div className="my-1 flex flex-col gap-1.5 rounded-control border border-text-muted/30 bg-surface-raised p-2">
			<Textarea
				ref={textareaRef}
				aria-label={t("changes.commentLabel", { range: rangeLabel })}
				value={text}
				onChange={(event) => {
					const next = event.target.value;
					if (next.length > REVIEW_COMMENT_TEXT_MAX_CHARS) {
						setText(next.slice(0, REVIEW_COMMENT_TEXT_MAX_CHARS));
						setIssue("text");
						return;
					}
					setText(next);
					setIssue(null);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") onCancel();
					if (event.key === "Enter" && !event.shiftKey && trimmed.length > 0) {
						event.preventDefault();
						submit();
					}
				}}
				placeholder={t("changes.commentPlaceholder", { range: rangeLabel })}
				rows={2}
				className="resize-none font-sans text-xs"
			/>
			{issueMessage !== null && (
				<p role="alert" className="font-sans text-xs text-danger">
					{issueMessage}
				</p>
			)}
			<div className="flex items-center justify-end gap-1.5">
				<Button size="sm" type="button" onClick={onCancel} variant="ghost">
					{t("changes.commentCancel")}
				</Button>
				<Button size="sm" type="button" disabled={trimmed.length === 0} onClick={submit}>
					{t("changes.commentAdd")}
				</Button>
			</div>
		</div>
	);
}
