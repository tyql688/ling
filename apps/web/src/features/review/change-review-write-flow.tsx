import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Textarea } from "@renderer/components/ui/textarea";
import { useTranslation } from "react-i18next";
import type { ChangeReviewWriteTarget } from "./use-change-review-write-flow";

export function ChangeReviewCommitDialog({
	target,
	message,
	error,
	committing,
	onMessageChange,
	onClose,
	onCommit,
}: {
	target: ChangeReviewWriteTarget | null;
	message: string;
	error: string | null;
	committing: boolean;
	onMessageChange: (message: string) => void;
	onClose: () => void;
	onCommit: (push: boolean) => void;
}) {
	const { t } = useTranslation();
	return (
		<Dialog
			open={target !== null}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !committing) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("changes.commitTitle")}</DialogTitle>
					<DialogDescription>
						{target ? t("changes.commitDescription", { count: target.count }) : null}
					</DialogDescription>
				</DialogHeader>
				<Textarea
					aria-label={t("changes.commitMessageLabel")}
					value={message}
					onChange={(event) => onMessageChange(event.target.value)}
					rows={5}
					className="mt-4 min-h-28 resize-none"
				/>
				{error && (
					<FeedbackNotice tone="danger" className="mt-2 text-xs">
						<p className="whitespace-pre-wrap">{error}</p>
					</FeedbackNotice>
				)}
				<DialogFooter className="mt-4">
					<Button type="button" variant="outline" disabled={committing} onClick={onClose}>
						{t("session.cancel")}
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => onCommit(true)}
						disabled={committing || message.trim().length === 0}
					>
						{t("changes.commitAndPush")}
					</Button>
					<Button type="button" onClick={() => onCommit(false)} disabled={committing || message.trim().length === 0}>
						{t("git.commit")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function ChangeReviewDiscardDialog({
	target,
	error,
	discarding,
	onClose,
	onDiscard,
}: {
	target: ChangeReviewWriteTarget | null;
	error: string | null;
	discarding: boolean;
	onClose: () => void;
	onDiscard: () => void;
}) {
	const { t } = useTranslation();
	return (
		<Dialog
			open={target !== null}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !discarding) onClose();
			}}
		>
			<DialogContent size="compact">
				<DialogHeader>
					<DialogTitle>{t("changes.discardTitle")}</DialogTitle>
					<DialogDescription>
						{target ? t("changes.discardDescription", { count: target.count }) : null}
					</DialogDescription>
				</DialogHeader>
				{error && (
					<FeedbackNotice tone="danger" className="mt-3 text-xs">
						<p className="whitespace-pre-wrap">{error}</p>
					</FeedbackNotice>
				)}
				<DialogFooter className="mt-4">
					<Button type="button" variant="outline" disabled={discarding} onClick={onClose}>
						{t("session.cancel")}
					</Button>
					<Button type="button" variant="danger" onClick={onDiscard} disabled={discarding}>
						{t("changes.discard")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
