import type { SessionMessage } from "@ling/contracts/session-messages";
import { partsText } from "@renderer/features/chat/transcript/message-text";
import { type ChangeReviewTurn, TurnChangesCard } from "@renderer/features/review/turn-changes-card";
import type { TranscriptViewportPin } from "@renderer/features/sessions/runtime/transcript-scroll-memory";
import { cn } from "@renderer/lib/utils";
import { memo } from "react";
import { AssistantMessage } from "./assistant-message";
import { resolveMessageImages } from "./message-images";
import { ModelChangeDivider } from "./model-change-divider";
import { useSessionImageRef } from "./session-image-source";
import { ToolResultBlock } from "./tool-result";
import { ActivityGroup } from "./transcript-activity";
import type { TranscriptRow } from "./transcript-row-model";
import {
	BranchSummaryDivider,
	CompactionDivider,
	CustomMessageBlock,
	TurnFoldDivider,
	UserMessageBubble,
} from "./transcript-rows";

interface TranscriptRowViewProps {
	row: TranscriptRow;
	rowId: string;
	/** Semantic revision — the primary memo gate for row content. */
	revision: string;
	busy: boolean;
	isLastMessage: boolean;
	showAssistantError: boolean;
	editDraft: string | null;
	disclosures: ReadonlyMap<string, boolean> | undefined;
	reviewTurn: ChangeReviewTurn | undefined;
	toolsExpanded: boolean;
	hiddenThinkingLabel: string | null;
	/** Backward-looking use only (model-change divider derivation); deliberately outside
	 * the comparator — see areTranscriptRowPropsEqual. */
	messages: SessionMessage[];
	onToggleFold: (turnKey: string, expanded: boolean) => void;
	onPinViewport: (pin: TranscriptViewportPin) => void;
	onDisclosureChange: (rowId: string, key: string, expanded: boolean) => void;
	onOpenTurnReview: (turnId: string | null, path?: string) => void;
	onRevertTurn: (turnId: string) => void;
	onRetryTurn: ((entryId: string) => void) | undefined;
	onFork: (forkEntryId: string) => void;
	onBeginUserEdit: (rowId: string, text: string) => void;
	onUserEditDraftChange: (rowId: string, draft: string) => void;
	onCancelUserEdit: (rowId: string) => void;
	/** `entryId` is the durable rewind target — the edited message's own session entry. */
	onSubmitUserEdit: (entryId: string, newText: string) => void;
}

function rowOrdinal(row: TranscriptRow): number {
	return row.kind === "plain" ? row.userMessageOrdinal : -1;
}
/** The memo gate for transcript rows. Everything a row renders from is covered by
 * (rowId, revision) plus the explicit fields below; callbacks are stable identities
 * (use-stable-callback) and `messages` is backward-looking divider input, so both stay
 * outside the comparison on purpose. Ordinals compare separately because prepending
 * older pages shifts them without touching the revision. */
function areTranscriptRowPropsEqual(prev: TranscriptRowViewProps, next: TranscriptRowViewProps): boolean {
	return (
		prev.rowId === next.rowId &&
		prev.revision === next.revision &&
		prev.busy === next.busy &&
		prev.isLastMessage === next.isLastMessage &&
		prev.showAssistantError === next.showAssistantError &&
		prev.editDraft === next.editDraft &&
		Boolean(prev.onRetryTurn) === Boolean(next.onRetryTurn) &&
		prev.disclosures === next.disclosures &&
		rowOrdinal(prev.row) === rowOrdinal(next.row) &&
		(prev.row.kind !== "turnChanges" || prev.reviewTurn === next.reviewTurn)
	);
}

export const TranscriptRowView = memo(function TranscriptRowView({
	row,
	rowId,
	busy,
	isLastMessage,
	showAssistantError,
	editDraft,
	disclosures,
	reviewTurn,
	toolsExpanded,
	hiddenThinkingLabel,
	messages,
	onToggleFold,
	onPinViewport,
	onDisclosureChange,
	onOpenTurnReview,
	onRevertTurn,
	onFork,
	onRetryTurn,
	onBeginUserEdit,
	onUserEditDraftChange,
	onCancelUserEdit,
	onSubmitUserEdit,
}: TranscriptRowViewProps) {
	const imageRef = useSessionImageRef();
	if (row.kind === "turnFold") {
		return (
			<TurnFoldDivider
				row={row}
				busy={busy}
				onRetry={onRetryTurn}
				onToggle={onToggleFold}
				onPinViewport={onPinViewport}
			/>
		);
	}
	if (row.kind === "turnChanges") {
		if (!reviewTurn) return null;
		return (
			<TurnChangesCard
				turn={reviewTurn}
				expanded={disclosures?.get("files") ?? false}
				onExpandedChange={(expanded) => onDisclosureChange(rowId, "files", expanded)}
				onOpenFile={(path) => onOpenTurnReview(reviewTurn.id, path)}
				onReview={() => onOpenTurnReview(reviewTurn.id)}
				onRevert={reviewTurn.tracking.status === "complete" && !busy ? () => onRevertTurn(reviewTurn.id) : undefined}
			/>
		);
	}
	if (row.kind === "activity") {
		return (
			<ActivityGroup
				row={row}
				toolsExpanded={toolsExpanded}
				hiddenThinkingLabel={hiddenThinkingLabel}
				disclosures={disclosures}
				onDisclosureChange={(key, expanded) => onDisclosureChange(rowId, key, expanded)}
				onOpenFileReview={(path) => onOpenTurnReview(null, path)}
			/>
		);
	}

	const { index, message } = row;
	if (message.role === "compactionSummary") {
		return <CompactionDivider summary={message.summary} />;
	}
	if (message.role === "branchSummary") {
		return <BranchSummaryDivider summary={message.summary} />;
	}
	if (message.role === "modelChange") {
		return <ModelChangeDivider message={message} messages={messages} index={index} />;
	}
	if (message.role === "user") {
		const images = resolveMessageImages(message.content, imageRef);
		const text = partsText(message.content);
		const ordinal = row.userMessageOrdinal;
		// A message with no entry yet is not on disk, so there is nothing to rewind to.
		const entryId = message.entryId;
		// Pop the bubble in only when it was just sent; a historical row mounting on scroll stays still.
		const justSent = message.timestamp !== undefined && Date.now() - message.timestamp < 1500;
		return (
			<div
				data-turn={ordinal}
				className={cn(
					"scroll-mt-8",
					justSent && "animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none",
				)}
			>
				<UserMessageBubble
					text={text}
					images={images}
					disabled={busy}
					editDraft={editDraft}
					onBeginEdit={() => onBeginUserEdit(rowId, text)}
					onEditDraftChange={(draft) => onUserEditDraftChange(rowId, draft)}
					onCancelEdit={() => onCancelUserEdit(rowId)}
					onEdit={entryId === null ? undefined : (newText) => onSubmitUserEdit(entryId, newText)}
				/>
			</div>
		);
	}
	if (message.role === "assistant")
		return (
			<AssistantMessage
				message={message}
				busy={busy}
				streaming={isLastMessage && busy}
				showError={showAssistantError}
				onFork={onFork}
			/>
		);

	if (message.role === "toolResult") {
		return <ToolResultBlock message={message} />;
	}
	if (message.role === "custom") {
		return <CustomMessageBlock message={message} toolsExpanded={toolsExpanded} />;
	}
	return null;
}, areTranscriptRowPropsEqual);
