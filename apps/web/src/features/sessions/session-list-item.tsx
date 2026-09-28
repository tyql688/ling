import { SESSION_TITLE_MAX_CHARS, type SessionSummary } from "@ling/contracts/session";
import { sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { StatusGlyph } from "@renderer/components/ui/status-glyph";
import type { StatusMeaning } from "@renderer/components/ui/status-presentation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import type { WorkspaceSessionStatus, WorkspaceSessionStatusEntry } from "@renderer/features/sessions/session-status";
import { useBoundedTextInput } from "@renderer/hooks/use-bounded-text-input";
import { useImeGuard } from "@renderer/hooks/use-ime-guard";
import { formatAbsoluteTime, relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { AlertCircle, Archive, ListPlus, Pin, Undo2 } from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { sessionMenuGroups } from "./session-menu";
import { sessionStatusLabelKey } from "./session-status";

type SessionRowVariant = "active" | "archived";

interface SessionListItemProps {
	session: SessionSummary;
	projectName: string;
	showProjectContext: boolean;
	isActive: boolean;
	variant: SessionRowVariant;
	status: WorkspaceSessionStatusEntry;
	now: number;
	onSelect: () => void;
	onRename: (title: string) => void;
	onFork: () => void;
	onPin: (pinned: boolean) => void;
	onArchive: (archived: boolean) => void;
	onDelete: () => void;
	onReveal: () => void;
	/** Only the active session can compact — the runtime command needs its live binding. */
	onCompact?: (() => void) | undefined;
}

/** Statuses shown in the row's trailing slot; unread ("done") is the leading dot instead. */
const TRAILING_STATUS_MEANINGS: Partial<Record<WorkspaceSessionStatus, StatusMeaning>> = {
	approval: "attention",
	input: "attention",
	working: "active",
	failed: "error",
};

export function SessionListItem({
	session,
	projectName,
	showProjectContext,
	isActive,
	variant,
	status,
	now,
	onSelect,
	onRename,
	onFork,
	onPin,
	onArchive,
	onDelete,
	onReveal,
	onCompact,
}: SessionListItemProps) {
	const { t } = useTranslation();
	const key = sessionKey(toSessionRef(session));
	const activityLabel = t("sidebar.lastActivityAt", { time: formatAbsoluteTime(session.updatedAt) });
	const statusLabelKey = sessionStatusLabelKey(status.status);
	const statusLabel = statusLabelKey === null ? null : t(statusLabelKey);
	const statusMeaning = TRAILING_STATUS_MEANINGS[status.status];
	const unread = status.status === "done";
	const queuedLabel = status.queuedCount > 0 ? t("sidebar.queued", { count: status.queuedCount }) : null;
	// One row tooltip carries status and queue text because the trailing slot yields to hover actions.
	const rowTooltip = [statusLabel, queuedLabel, activityLabel].filter((part) => part !== null).join(" · ");
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValueState] = useState(session.title);
	const { limitExceeded: titleLimitExceeded, setBoundedValue: setEditValue } = useBoundedTextInput(
		setEditValueState,
		SESSION_TITLE_MAX_CHARS,
	);
	const inputRef = useRef<HTMLInputElement>(null);
	const ime = useImeGuard();

	useEffect(() => {
		ime.resetComposition();
		if (!editing) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [editing, ime]);

	const startEditing = () => {
		ime.resetComposition();
		setEditValue(session.title);
		setEditing(true);
	};

	const confirmEditing = () => {
		ime.resetComposition();
		setEditing(false);
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== session.title) onRename(trimmed);
	};

	const handlePrimaryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== " " && event.key !== "Enter") return;
		event.preventDefault();
		onSelect();
	};

	const archiveAction = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
		onArchive(variant !== "archived");
	};

	const pinAction = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
		onPin(session.pinnedAt === undefined);
	};

	const titleNode = editing ? (
		<div className="flex min-w-0 flex-1 items-center gap-1">
			<input
				ref={inputRef}
				value={editValue}
				onChange={(event) => setEditValue(event.target.value)}
				onClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (ime.isComposing(event)) return;
					if (event.key === "Enter") confirmEditing();
					if (event.key === "Escape") {
						setEditing(false);
						setEditValue(session.title);
					}
				}}
				onBlur={confirmEditing}
				{...ime.compositionProps}
				aria-invalid={titleLimitExceeded}
				className={cn(
					"h-4 min-w-0 flex-1 border-0 bg-transparent p-0 text-ui leading-4 text-text-primary outline-none",
					(isActive || unread) && "font-medium",
				)}
			/>
			{titleLimitExceeded && (
				<span
					role="alert"
					aria-label={t("session.titleTextLimit", { count: SESSION_TITLE_MAX_CHARS })}
					className="shrink-0 text-danger"
				>
					<AlertCircle className="size-3.5" aria-hidden="true" />
				</span>
			)}
		</div>
	) : (
		<span className={cn("min-w-0 flex-1 truncate text-ui leading-4", (isActive || unread) && "font-medium")}>
			{session.title}
		</span>
	);

	const queueNode =
		queuedLabel === null ? null : (
			<span
				role="status"
				aria-label={queuedLabel}
				className="inline-flex shrink-0 items-center gap-0.5 tabular-nums text-text-muted"
			>
				<ListPlus className="size-3" aria-hidden="true" />
				{status.queuedCount}
			</span>
		);
	const statusNode =
		statusMeaning === undefined || statusLabel === null ? null : (
			<span role="img" aria-label={statusLabel} className="inline-flex size-4 shrink-0 items-center justify-center">
				<StatusGlyph status={statusMeaning} />
			</span>
		);
	const timeNode = (
		<time dateTime={new Date(session.updatedAt).toISOString()} className="shrink-0 tabular-nums">
			<span className="sr-only">{activityLabel}</span>
			<span aria-hidden="true">{relativeTime(session.updatedAt, now)}</span>
		</time>
	);
	const pinMark = session.pinnedAt !== undefined && (
		<Pin className="size-3 shrink-0 text-text-muted" aria-hidden="true" />
	);
	const twoLine = variant === "active" && showProjectContext;
	// Hover and keyboard focus replace the trailing slot with row actions: sr-only keeps its text in the
	// button's accessible name, and the extra end padding keeps the title clear of the action buttons.
	const actionReserve = editing
		? undefined
		: variant === "active"
			? "group-hover/session:pr-15 group-has-[:focus-visible]/session:pr-15"
			: "group-hover/session:pr-8 group-has-[:focus-visible]/session:pr-8";
	const trailingNode = (
		<span
			className={cn(
				"flex shrink-0 items-center gap-1.5 text-xs text-text-muted",
				!editing && "group-hover/session:sr-only group-has-[:focus-visible]/session:sr-only",
			)}
		>
			{unread && <span className="sr-only">{statusLabel}</span>}
			{queueNode}
			{statusNode}
			{!twoLine && statusNode === null && timeNode}
		</span>
	);

	const rowContent = twoLine ? (
		<div className={cn("flex h-11 min-w-0 items-center gap-2 pr-2 pl-3", actionReserve)}>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-1.5">
					{pinMark}
					{titleNode}
				</div>
				<div className="flex min-w-0 items-center text-xs text-text-muted">
					<span className="min-w-0 truncate">{projectName}</span>
					<span aria-hidden="true" className="shrink-0 px-1">
						·
					</span>
					{timeNode}
				</div>
			</div>
			{trailingNode}
		</div>
	) : (
		<div className={cn("flex h-8 min-w-0 items-center gap-1.5 pr-2 pl-3", actionReserve)}>
			{pinMark}
			{titleNode}
			{trailingNode}
		</div>
	);
	const primaryButton = (
		<button
			type="button"
			data-session-key={key}
			aria-current={isActive ? "page" : undefined}
			onClick={onSelect}
			onKeyDown={handlePrimaryKeyDown}
			className="block w-full cursor-default rounded-control text-left focus-visible:bg-surface-hover"
		>
			{rowContent}
		</button>
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					className={cn(
						"group/session relative isolate w-full overflow-hidden rounded-control text-left text-text-primary transition-[background-color]",
						!isActive && "hover:bg-surface-hover/75",
						variant === "archived" && !isActive && "text-text-muted",
					)}
				>
					{isActive && (
						// Shared layoutId: the active card slides from the previous session row to this one
						// instead of blinking off and on. Sits behind the row content via the isolate stack.
						<motion.span
							layoutId="session-active-card"
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 -z-10 rounded-control border border-border-subtle bg-sidebar-active shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
							transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
						/>
					)}
					{unread && (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute top-1/2 left-1 size-1.5 -translate-y-1/2 rounded-full bg-accent"
						/>
					)}
					{editing ? (
						<div className="w-full text-left">{rowContent}</div>
					) : (
						<Tooltip>
							<TooltipTrigger render={primaryButton} />
							<TooltipContent side="right">{rowTooltip}</TooltipContent>
						</Tooltip>
					)}
					{!editing && variant === "active" && (
						<TooltipIconButton
							onClick={pinAction}
							label={t(session.pinnedAt !== undefined ? "session.ctxUnpin" : "session.ctxPin")}
							className={cn(
								"pointer-events-none absolute top-1/2 right-8 z-10 size-6 -translate-y-1/2 bg-transparent opacity-0 shadow-none group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-has-[:focus-visible]/session:pointer-events-auto group-has-[:focus-visible]/session:opacity-100",
								session.pinnedAt !== undefined && "text-text-primary",
							)}
						>
							<Pin
								className="size-3.5"
								fill={session.pinnedAt !== undefined ? "currentColor" : "none"}
								aria-hidden="true"
							/>
						</TooltipIconButton>
					)}
					{!editing && (
						<TooltipIconButton
							onClick={archiveAction}
							label={t(variant === "active" ? "session.ctxArchive" : "session.ctxUnarchive")}
							className="pointer-events-none absolute top-1/2 right-1 z-10 size-6 -translate-y-1/2 bg-transparent opacity-0 shadow-none group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-has-[:focus-visible]/session:pointer-events-auto group-has-[:focus-visible]/session:opacity-100"
						>
							{variant === "active" ? (
								<Archive className="size-3.5" aria-hidden="true" />
							) : (
								<Undo2 className="size-3.5" aria-hidden="true" />
							)}
						</TooltipIconButton>
					)}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent
				className="w-48"
				onCloseAutoFocus={(event) => {
					// Rename replaces the menu trigger with an input; keep focus on that new editor.
					if (inputRef.current === null) return;
					event.preventDefault();
					inputRef.current.focus();
				}}
			>
				{sessionMenuGroups(
					{
						id: session.id,
						cwd: session.cwd,
						pinned: session.pinnedAt !== undefined,
						archived: session.archivedAt !== undefined,
					},
					{
						onRename: startEditing,
						onPin,
						onArchive,
						onFork,
						onCompact,
						onReveal,
						onDelete,
					},
				).map((group, index, groups) => (
					// eslint-disable-next-line react/no-array-index-key -- groups are a fixed, ordered structure.
					<div key={index} className="contents">
						{group.map((entry) => (
							<ContextMenuItem
								key={entry.key}
								{...(entry.destructive ? { variant: "destructive" as const } : {})}
								onClick={entry.onSelect}
							>
								{t(entry.labelKey)}
							</ContextMenuItem>
						))}
						{index < groups.length - 1 && <ContextMenuSeparator />}
					</div>
				))}
			</ContextMenuContent>
		</ContextMenu>
	);
}
