import { useDomainApi } from "@renderer/lib/host-api-context";
import type { CommitChangeReviewRequest } from "@ling/contracts/git";
import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { formatRequestError } from "@renderer/lib/errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** One in-flight commit/discard request; the revision invalidates stale completions. */
export interface ChangeReviewWriteTarget {
	revision: number;
	snapshotId: string;
	scope: CommitChangeReviewRequest["scope"];
	count: number;
}

/**
 * Commit/discard write flow of the change review panel: dialog targets, in-flight
 * guards, and the revision that invalidates a stale async completion (dialog closed,
 * session switched). A completion past its revision must not touch any state.
 */
export function useChangeReviewWriteFlow({ sessionRef, onRefresh }: { sessionRef: SessionRef; onRefresh: () => void }) {
	const hostChangeReviewApi = useDomainApi("changeReview");
	const hostGitApi = useDomainApi("git");

	const { t } = useTranslation();
	const [commitTarget, setCommitTarget] = useState<ChangeReviewWriteTarget | null>(null);
	const [commitMessage, setCommitMessage] = useState("");
	const [commitError, setCommitError] = useState<string | null>(null);
	const [committing, setCommitting] = useState(false);
	const [discardTarget, setDiscardTarget] = useState<ChangeReviewWriteTarget | null>(null);
	const [discardError, setDiscardError] = useState<string | null>(null);
	const [discarding, setDiscarding] = useState(false);
	const writeRevisionRef = useRef(0);
	const writeStorageKey = sessionKey(sessionRef);

	// Switching sessions invalidates any in-flight write and drops both dialogs.

	// keyed on the session identity, not on referenced values.
	useEffect(() => {
		writeRevisionRef.current += 1;
		setCommitTarget(null);
		setCommitError(null);
		setCommitting(false);
		setDiscardTarget(null);
		setDiscardError(null);
		setDiscarding(false);
	}, [writeStorageKey]);

	const closeCommitDialog = useCallback((): void => {
		writeRevisionRef.current += 1;
		setCommitTarget(null);
	}, []);

	const closeDiscardDialog = useCallback((): void => {
		writeRevisionRef.current += 1;
		setDiscardTarget(null);
	}, []);

	// Panel close dismisses both dialogs WITHOUT invalidating an in-flight write:
	// its completion still refreshes the snapshot so a reopened panel is fresh.
	const dismissWriteDialogs = useCallback((): void => {
		setCommitTarget(null);
		setDiscardTarget(null);
	}, []);

	const openCommitDialog = (snapshotId: string, scope: CommitChangeReviewRequest["scope"], count: number): void => {
		writeRevisionRef.current += 1;
		setCommitError(null);
		setCommitMessage(t("changes.commitMessageDefault", { count }));
		setCommitTarget({ revision: writeRevisionRef.current, snapshotId, scope, count });
	};

	const commitScope = (push: boolean): void => {
		if (!commitTarget) return;
		const target = commitTarget;
		const isCurrent = (): boolean => writeRevisionRef.current === target.revision;
		setCommitting(true);
		setCommitError(null);
		void hostChangeReviewApi
			.commit({
				ref: sessionRef,
				snapshotId: target.snapshotId,
				scope: target.scope,
				paths: [],
				message: commitMessage,
			})
			.then(async () => {
				if (push) {
					// The commit is already recorded — a push failure must say so, not read
					// like the commit failed.
					try {
						await hostGitApi.push({ cwd: sessionRef.cwd });
					} catch (cause) {
						if (isCurrent()) {
							setCommitError(t("changes.pushAfterCommitFailed", { message: formatRequestError(cause) }));
							onRefresh();
						}
						return;
					}
				}
				if (!isCurrent()) return;
				setCommitTarget(null);
				onRefresh();
			})
			.catch((cause: unknown) => {
				if (isCurrent()) setCommitError(formatRequestError(cause));
			})
			.finally(() => {
				if (isCurrent()) setCommitting(false);
			});
	};

	const openDiscardDialog = (snapshotId: string, scope: CommitChangeReviewRequest["scope"], count: number): void => {
		writeRevisionRef.current += 1;
		setDiscardError(null);
		setDiscardTarget({ revision: writeRevisionRef.current, snapshotId, scope, count });
	};

	const discardScope = (): void => {
		if (!discardTarget) return;
		const target = discardTarget;
		const isCurrent = (): boolean => writeRevisionRef.current === target.revision;
		setDiscarding(true);
		setDiscardError(null);
		void hostChangeReviewApi
			.discard({ ref: sessionRef, snapshotId: target.snapshotId, scope: target.scope, paths: [] })
			.then(() => {
				if (!isCurrent()) return;
				setDiscardTarget(null);
				onRefresh();
			})
			.catch((cause: unknown) => {
				if (isCurrent()) setDiscardError(formatRequestError(cause));
			})
			.finally(() => {
				if (isCurrent()) setDiscarding(false);
			});
	};

	return {
		commitTarget,
		commitMessage,
		setCommitMessage,
		commitError,
		committing,
		openCommitDialog,
		closeCommitDialog,
		commitScope,
		discardTarget,
		discardError,
		discarding,
		openDiscardDialog,
		closeDiscardDialog,
		discardScope,
		dismissWriteDialogs,
		/** Contributes to the panel's nestedDialogOpen: an open write dialog blocks closing. */
		writeDialogOpen: commitTarget !== null || discardTarget !== null,
	};
}
