import type { DialogDismissEvent } from "@ling/contracts/session";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { createDialogRequestReplay, removeDialogRequest } from "@renderer/lib/dialog-request-replay";
import { formatRequestError } from "@renderer/lib/errors";
import { type PrimitiveAtom, useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface DialogRequestIdentity {
	requestId: string;
}

interface PairedDialogBridge<TRequest extends DialogRequestIdentity> {
	getPending(): Promise<TRequest[]>;
	onRequest(callback: (request: TRequest) => void): () => void;
	onDismiss?(callback: (event: DialogDismissEvent) => void): () => void;
}

export function usePairedDialogQueue<TRequest extends DialogRequestIdentity>(
	queueAtom: PrimitiveAtom<TRequest[]>,
	bridge: PairedDialogBridge<TRequest>,
) {
	const [queue, setQueue] = useAtom(queueAtom);
	const replayRef = useRef<ReturnType<typeof createDialogRequestReplay<TRequest>> | null>(null);
	const { getPending, onDismiss, onRequest } = bridge;
	const feedback = useAppFeedback();
	const { t } = useTranslation();

	useEffect(() => {
		let active = true;
		const replay = createDialogRequestReplay<TRequest>();
		replayRef.current = replay;

		// Subscribe before fetching so requests created while the snapshot is in
		// flight are captured and reconciled rather than missed or duplicated.
		const unsubscribeRequest = onRequest((request) => {
			setQueue((current) => replay.receive(current, request));
		});
		const unsubscribeDismiss = onDismiss
			? onDismiss((event) => {
					setQueue((current) => replay.dismiss(current, event.requestId));
				})
			: null;

		void getPending()
			.then((pending) => {
				if (!active) return;
				setQueue(replay.reconcile(pending));
			})
			.catch((error: unknown) => {
				if (!active) return;
				// Fail-fast: never pretend pending dialogs reconciled successfully.
				feedback.show({
					tone: "danger",
					title: t("session.dialogPendingLoadFailed"),
					description: formatRequestError(error),
					dedupeKey: "paired-dialog-pending-load",
				});
			});

		return () => {
			active = false;
			unsubscribeRequest();
			unsubscribeDismiss?.();
			if (replayRef.current === replay) replayRef.current = null;
		};
	}, [feedback, getPending, onDismiss, onRequest, setQueue, t]);

	const remove = useCallback(
		(requestId: string) => {
			setQueue((current) => {
				const replay = replayRef.current;
				return replay ? replay.dismiss(current, requestId) : removeDialogRequest(current, requestId);
			});
		},
		[setQueue],
	);

	return { queue, remove };
}
