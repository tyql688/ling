import { parseSessionKey, sessionKey } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { useDataIssue } from "@renderer/lib/data-health/state";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { draftPersistenceActionsAtom, draftPersistenceStatusAtom } from "./state/draft-persistence";
import { NEW_CONVERSATION_DRAFT_KEY } from "./state/drafts";
import { sessionsAtom } from "./state/session";

export function DraftPersistenceFeedback() {
	const { restoreFailed, saveError, omitted, conflicts, localConflicts } = useAtomValue(draftPersistenceStatusAtom);
	const actions = useAtomValue(draftPersistenceActionsAtom);
	const sessions = useAtomValue(sessionsAtom);
	const [open, setOpen] = useState(false);
	const [working, setWorking] = useState(false);
	const { t } = useTranslation();
	function draftLabel(key: string) {
		if (key === NEW_CONVERSATION_DRAFT_KEY) return t("nav.newConversation");
		const ref = parseSessionKey(key);
		if (ref === null) return t("session.draftSavedVersion");
		return (
			sessions.find((session) => sessionKey({ cwd: session.cwd, sessionId: session.id }) === key)?.title ?? ref.cwd
		);
	}
	useDataIssue(
		"ling/drafts",
		restoreFailed || saveError !== null || omitted > 0 || conflicts.length > 0 || localConflicts.length > 0
			? {
					label: t("data.drafts"),
					message:
						saveError ??
						(restoreFailed
							? t("session.draftRestorePartial")
							: omitted > 0
								? t("session.draftStorageLimit", { count: omitted })
								: t("session.draftConflictDescription")),
					...(actions ? { retry: actions.retry } : {}),
					...(conflicts.length > 0 || localConflicts.length > 0
						? {
								action: {
									label: t("session.draftReviewVersions"),
									run: async () => {
										setOpen(true);
									},
								},
							}
						: {}),
				}
			: null,
	);
	async function run(operation: () => Promise<void>) {
		setWorking(true);
		try {
			await operation();
		} finally {
			setWorking(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="flex max-h-[80dvh] flex-col">
				<DialogHeader>
					<DialogTitle>{t("session.draftReviewVersions")}</DialogTitle>
					<DialogDescription>{t("session.draftConflictDescription")}</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 overflow-y-auto divide-y divide-border-subtle">
					{localConflicts.map((key) => (
						<div key={key} className="space-y-3 py-4">
							<p className="text-sm">{t("session.draftLocalConflict")}</p>
							<p className="break-all text-xs text-text-muted">{draftLabel(key)}</p>
							<div className="flex flex-wrap gap-2">
								<Button
									disabled={working || !actions}
									size="sm"
									onClick={() => {
										if (actions) void run(() => actions.resolveLocal(key, "local"));
									}}
								>
									{t("session.draftUseLocal")}
								</Button>
								<Button
									disabled={working || !actions}
									size="sm"
									variant="outline"
									onClick={() => {
										if (actions) void run(() => actions.resolveLocal(key, "remote"));
									}}
								>
									{t("session.draftUseRemote")}
								</Button>
							</div>
						</div>
					))}
					{conflicts.map((conflict) => (
						<div key={conflict.id} className="space-y-3 py-4">
							<p className="text-xs text-text-muted">{new Date(conflict.savedAt).toLocaleString()}</p>
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">
								{conflict.draft.text || t("session.draftContextOnly")}
							</pre>
							<p className="text-xs text-text-muted">
								{t("session.draftContextCount", {
									count:
										conflict.draft.fileReferences.length +
										conflict.draft.pastedBlocks.length +
										conflict.draft.reviewComments.length,
								})}
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="outline"
									disabled={working || !actions || localConflicts.includes(conflict.key)}
									onClick={() => {
										if (actions) void run(() => actions.resolveRecovery(conflict.id, "recover"));
									}}
								>
									{t("session.draftRestoreVersion")}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={working || !actions}
									onClick={() => {
										if (actions) void run(() => actions.resolveRecovery(conflict.id, "discard"));
									}}
								>
									{t("session.draftRemoveVersion")}
								</Button>
							</div>
						</div>
					))}
					{conflicts.length === 0 && localConflicts.length === 0 && (
						<p className="py-4 text-sm text-text-muted">{t("session.draftConflictsResolved")}</p>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
