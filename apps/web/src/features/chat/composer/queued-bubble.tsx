import type { SessionQueuedMessage } from "@ling/contracts/session";
import { mergeFileReferenceTargets } from "@ling/contracts/file-reference-text";
import { Clock3, Pencil, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface QueueActions {
	/** Queue mutations pause while one message owns the composer edit overlay. */
	disabled: boolean;
	/** Move a queued message into the main composer for editing. */
	startEdit: (
		kind: "steering" | "followUp",
		index: number,
		expectedRevision: number,
		message: SessionQueuedMessage,
	) => void;
	/** Edit (text) or remove (null) a queued message; expectedText guards against the queue
	 * shifting between read and write (main rejects a mismatch). */
	edit: (
		kind: "steering" | "followUp",
		index: number,
		expectedRevision: number,
		expectedText: string,
		text: string | null,
	) => void;
	/** Promote a queued follow-up into the current run as a steering message. */
	promote: (index: number, expectedRevision: number, expectedText: string) => void;
}

export function QueuedBubble({
	message,
	kind,
	index,
	queueRevision,
	actions,
}: {
	message: SessionQueuedMessage;
	kind: "steering" | "followUp";
	index: number;
	queueRevision: number;
	actions: QueueActions;
}) {
	const { t } = useTranslation();
	const chipButton =
		"inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:text-text-primary disabled:pointer-events-none disabled:opacity-40";
	const displayText = mergeFileReferenceTargets(
		message.draftText.length === 0 ? null : message.draftText,
		message.fileReferences,
	);

	return (
		<div className="group/queued pointer-events-auto flex max-w-[80%] items-center gap-1.5 rounded-full border border-dashed border-border-subtle bg-surface/90 px-3 py-1.5 text-xs text-text-muted shadow-sm backdrop-blur">
			<Clock3 className="size-3 shrink-0" aria-hidden="true" />
			<span className="shrink-0">{t(kind === "steering" ? "session.queuedSteer" : "session.queuedFollowUp")}</span>
			<span className="truncate">{displayText}</span>
			{!message.readOnly && (
				<>
					<button
						type="button"
						className={chipButton}
						aria-label={t("session.queuedEdit")}
						disabled={actions.disabled}
						onClick={() => actions.startEdit(kind, index, queueRevision, message)}
					>
						<Pencil className="size-3" aria-hidden="true" />
					</button>
					{kind === "followUp" && (
						<button
							type="button"
							className={chipButton}
							aria-label={t("session.queuedSteerNow")}
							title={t("session.queuedSteerNow")}
							disabled={actions.disabled}
							onClick={() => actions.promote(index, queueRevision, message.text)}
						>
							<Zap className="size-3" aria-hidden="true" />
						</button>
					)}
					<button
						type="button"
						className={`${chipButton} hover:text-danger`}
						aria-label={t("session.queuedRemove")}
						disabled={actions.disabled}
						onClick={() => actions.edit(kind, index, queueRevision, message.text, null)}
					>
						<X className="size-3" aria-hidden="true" />
					</button>
				</>
			)}
		</div>
	);
}
