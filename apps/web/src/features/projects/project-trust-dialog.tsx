import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ProjectTrustChoice } from "@ling/contracts/project";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { projectTrustQueueAtom } from "@renderer/features/projects/state";
import { usePairedDialogQueue } from "@renderer/hooks/use-paired-dialog-queue";
import { tildify } from "@renderer/lib/format-path";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * pi's project-trust gate, GUI form: a project with .pi/.agents resources loads them
 * only after the user trusts the folder (same store the pi CLI honors). Requests can
 * predate this component's mount (startup restore), hence the pending fetch.
 */
export function ProjectTrustDialog() {
	const hostProjectApi = useDomainApi("project");

	const { t } = useTranslation();
	const { queue, remove } = usePairedDialogQueue(projectTrustQueueAtom, {
		getPending: hostProjectApi.pendingTrustRequests,
		onRequest: hostProjectApi.onTrustRequest,
		onDismiss: hostProjectApi.onTrustDismiss,
	});
	const active = queue[0] ?? null;
	const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
	const [failedRequestId, setFailedRequestId] = useState<string | null>(null);
	const responding = active !== null && respondingRequestId === active.requestId;
	const responseError = active !== null && failedRequestId === active.requestId;

	const respond = useCallback(
		async (choice: ProjectTrustChoice | null) => {
			if (!active || responding) return;
			setRespondingRequestId(active.requestId);
			setFailedRequestId(null);
			try {
				await hostProjectApi.respondTrust(active.requestId, choice);
				remove(active.requestId);
			} catch {
				setFailedRequestId(active.requestId);
			} finally {
				setRespondingRequestId((current) => (current === active.requestId ? null : current));
			}
		},
		[hostProjectApi, active, remove, responding],
	);

	return (
		<Dialog
			open={active !== null}
			onOpenChange={(open) => {
				if (!open) void respond(null);
			}}
		>
			{active && (
				<DialogContent size="compact">
					<div className="flex flex-col gap-4">
						<DialogHeader>
							<DialogTitle>{t("project.trustTitle")}</DialogTitle>
							<DialogDescription>{t("project.trustDescription")}</DialogDescription>
						</DialogHeader>
						<p className="break-all rounded-control bg-surface-raised p-3 font-mono text-xs text-text-primary">
							{tildify(active.cwd)}
						</p>
						{responseError && (
							<FeedbackNotice tone="danger" className="text-sm">
								{t("project.trustResponseFailed")}
							</FeedbackNotice>
						)}
						<div className="flex flex-col gap-2">
							<Button disabled={responding} onClick={() => void respond("trust")}>
								{t("project.trustAlways")}
							</Button>
							<Button disabled={responding} variant="outline" onClick={() => void respond("session")}>
								{t("project.trustSession")}
							</Button>
							<Button disabled={responding} variant="outline" onClick={() => void respond("deny")}>
								{t("project.trustDeny")}
							</Button>
						</div>
					</div>
				</DialogContent>
			)}
		</Dialog>
	);
}
