import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@renderer/components/ui/dialog";
import { ApprovalPromptCard } from "@renderer/features/chat/extension-ui/approval-prompt-card";
import { usePairedDialogQueue } from "@renderer/hooks/use-paired-dialog-queue";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useTranslation } from "react-i18next";
import { pendingApprovalQueueAtom } from "./state/session";

/** Own the approval subscription even before a session's startup promise settles. */
export function StartupApprovalDialog() {
	const api = useDomainApi("session");
	const { t } = useTranslation();
	const { queue, remove } = usePairedDialogQueue(pendingApprovalQueueAtom, {
		getPending: api.pendingApprovalRequests,
		onRequest: api.onApprovalRequest,
		onDismiss: api.onApprovalDismiss,
	});
	const starting = queue.filter((request) => request.sessionStarting);
	const pending = starting[0];
	if (!pending) return null;
	return (
		<Dialog open>
			<DialogContent className="overflow-y-auto">
				<DialogTitle className="sr-only">{t("approval.requestLabel")}</DialogTitle>
				<DialogDescription className="mb-3 break-all font-mono text-xs">{pending.ref.cwd}</DialogDescription>
				<ApprovalPromptCard
					key={pending.requestId}
					request={pending}
					pendingCount={starting.length}
					onRespond={async (approved) => {
						await api.respondToApproval(pending.requestId, approved);
						remove(pending.requestId);
					}}
				/>
			</DialogContent>
		</Dialog>
	);
}
