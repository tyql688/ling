import type { SessionSummary } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import { toSessionRef } from "@ling/contracts/session-ref";
import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

function ChildSessionFooter({
	sessionRef,
	parentSession,
	onOpenSession,
	onContinueInFork,
}: {
	sessionRef: SessionRef;
	parentSession?: SessionSummary;
	onOpenSession: (ref: SessionRef) => void;
	onContinueInFork: (ref: SessionRef) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex w-full items-center gap-3 bg-surface px-4 py-3 text-sm text-text-muted">
			<Bot className="size-4 shrink-0" aria-hidden="true" />
			<p className="min-w-0 flex-1">{t("session.childReadOnly")}</p>
			{parentSession && (
				<button
					type="button"
					onClick={() => onOpenSession(toSessionRef(parentSession))}
					className="shrink-0 rounded-control px-2 py-1 text-text-primary transition-colors hover:bg-surface-hover"
				>
					{t("session.openParent")}
				</button>
			)}
			<button
				type="button"
				onClick={() => onContinueInFork(sessionRef)}
				className="shrink-0 rounded-control px-2 py-1 text-text-primary transition-colors hover:bg-surface-hover"
			>
				{t("session.continueInFork")}
			</button>
		</div>
	);
}

interface WorkspaceTimelineFooterProps {
	childSession: { ref: SessionRef; parent?: SessionSummary } | null;
	parentComposer: ReactNode;
	onOpenSession: (ref: SessionRef) => void;
	onContinueInFork: (ref: SessionRef) => void;
}

/** Keeps the composer in one stable layout slot; extension chrome is owned by the
 * workbench overlay so long status/footer output cannot move this footer. */
export function WorkspaceTimelineFooter({
	childSession,
	parentComposer,
	onOpenSession,
	onContinueInFork,
}: WorkspaceTimelineFooterProps) {
	return (
		<div className="relative w-full">
			{childSession === null ? (
				parentComposer
			) : (
				<ChildSessionFooter
					sessionRef={childSession.ref}
					{...(childSession.parent === undefined ? {} : { parentSession: childSession.parent })}
					onOpenSession={onOpenSession}
					onContinueInFork={onContinueInFork}
				/>
			)}
		</div>
	);
}
