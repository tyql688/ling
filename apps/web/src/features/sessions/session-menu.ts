interface SessionMenuEntry {
	key: string;
	labelKey: string;
	onSelect: () => void;
	destructive?: boolean;
}

export interface SessionMenuHandlers {
	onRename: () => void;
	onPin: (pinned: boolean) => void;
	onArchive: (archived: boolean) => void;
	onFork: () => void;
	/** Compacting runs against the live runtime, which only the active session has. */
	onCompact?: (() => void) | undefined;
	onReveal: () => void;
	onDelete: () => void;
}

/**
 * The one session menu. The sidebar row and tab strip render
 * these same groups so a session never offers different actions depending on where
 * it was clicked. Groups: state · session operations · path & id · put away.
 */
export function sessionMenuGroups(
	session: { id: string; cwd: string; pinned: boolean; archived: boolean },
	handlers: SessionMenuHandlers,
): SessionMenuEntry[][] {
	const copy = (text: string) => () => void navigator.clipboard.writeText(text);
	return [
		[
			{ key: "rename", labelKey: "session.ctxRename", onSelect: handlers.onRename },
			{
				key: "pin",
				labelKey: session.pinned ? "session.ctxUnpin" : "session.ctxPin",
				onSelect: () => handlers.onPin(!session.pinned),
			},
		],
		[
			{ key: "fork", labelKey: "session.ctxFork", onSelect: handlers.onFork },
			...(handlers.onCompact ? [{ key: "compact", labelKey: "session.ctxCompact", onSelect: handlers.onCompact }] : []),
		],
		[
			{ key: "reveal", labelKey: "session.ctxOpenInFinder", onSelect: handlers.onReveal },
			{ key: "copyPath", labelKey: "session.ctxCopyPath", onSelect: copy(session.cwd) },
			{ key: "copyId", labelKey: "session.ctxCopyId", onSelect: copy(session.id) },
		],
		[
			{
				key: "archive",
				labelKey: session.archived ? "session.ctxUnarchive" : "session.ctxArchive",
				onSelect: () => handlers.onArchive(!session.archived),
			},
			{ key: "delete", labelKey: "session.ctxDelete", onSelect: handlers.onDelete, destructive: true },
		],
	];
}
