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
import { STATUS_PRESENTATION, type StatusMeaning } from "@renderer/components/ui/status-presentation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import type { WorkspaceSessionStatus, WorkspaceSessionStatusEntry } from "@renderer/features/sessions/session-status";
import { useBoundedTextInput } from "@renderer/hooks/use-bounded-text-input";
import { useImeGuard } from "@renderer/hooks/use-ime-guard";
import { formatAbsoluteTime, relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { AlertCircle, Archive, Folder, ListPlus, Pin, Undo2 } from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
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
	onKeepOpen: () => void;
	onRename: (title: string) => void;
	onFork: () => void;
	onPin: (pinned: boolean) => void;
	onArchive: (archived: boolean) => void;
	onDelete: () => void;
	onReveal: () => void;
	/** Only the active session can compact — the runtime command needs its live binding. */
	onCompact?: (() => void) | undefined;
}

function statusPresentation(
	status: WorkspaceSessionStatus,
	t: ReturnType<typeof useTranslation>["t"],
): { label: string; className: string; icon: ReactNode } | null {
	const label = sessionStatusLabelKey(status);
	if (label === null) return null;
	const meanings: Record<WorkspaceSessionStatus, StatusMeaning> = {
		approval: "attention",
		input: "attention",
		working: "active",
		failed: "error",
		done: "success",
		ready: "neutral",
	};
	const meaning = meanings[status];
	return { label: t(label), className: STATUS_PRESENTATION[meaning].className, icon: <StatusGlyph status={meaning} /> };
}

/** The sidebar row's status glyph, shared with the session tab strip so both read the same. */
export function SessionStatusIcon({ status }: { status: WorkspaceSessionStatus }) {
	const { t } = useTranslation();
	return <StatusIcon presentation={statusPresentation(status, t)} />;
}

function StatusIcon({ presentation }: { presentation: ReturnType<typeof statusPresentation> }) {
	if (presentation === null) return null;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						role="img"
						aria-label={presentation.label}
						className={cn("inline-flex size-5 shrink-0 items-center justify-center", presentation.className)}
					/>
				}
			>
				{presentation.icon}
			</TooltipTrigger>
			<TooltipContent>{presentation.label}</TooltipContent>
		</Tooltip>
	);
}

export function SessionListItem({
	session,
	projectName,
	showProjectContext,
	isActive,
	variant,
	status,
	now,
	onSelect,
	onKeepOpen,
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
	const presentation = statusPresentation(status.status, t);
	const activityLabel = t("sidebar.lastActivityAt", { time: formatAbsoluteTime(session.updatedAt) });
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
		if (event.key === "Enter") onKeepOpen();
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
					isActive && "font-medium",
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
		<span className={cn("min-w-0 flex-1 truncate text-ui leading-4", isActive && "font-medium")}>{session.title}</span>
	);

	const queueNode =
		status.queuedCount > 0 ? (
			<Tooltip>
				<TooltipTrigger
					render={
						<span
							role="status"
							aria-label={t("sidebar.queued", { count: status.queuedCount })}
							className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-text-muted"
						/>
					}
				>
					<ListPlus className="size-3" aria-hidden="true" />
					{status.queuedCount}
				</TooltipTrigger>
				<TooltipContent>{t("sidebar.queued", { count: status.queuedCount })}</TooltipContent>
			</Tooltip>
		) : null;

	const metaNode = (
		<time
			dateTime={new Date(session.updatedAt).toISOString()}
			className="flex h-6 min-w-9 shrink-0 items-center justify-end text-xs tabular-nums text-text-primary/65 transition-opacity group-focus-within/session:opacity-0 group-hover/session:opacity-0"
		>
			<span className="sr-only">{activityLabel}</span>
			<span aria-hidden="true">{relativeTime(session.updatedAt, now)}</span>
		</time>
	);
	const statusNode = <StatusIcon presentation={presentation} />;

	const rowContent =
		variant === "active" && showProjectContext ? (
			<div className="flex h-[46px] min-w-0 items-center gap-1.5 px-2 py-1">
				{presentation !== null && (
					<span className="flex size-5 shrink-0 items-center justify-center">{statusNode}</span>
				)}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-1.5">
						{session.pinnedAt !== undefined && <Pin className="size-3 shrink-0 text-text-muted" aria-hidden="true" />}
						{titleNode}
						{queueNode}
					</div>
					<div className="flex min-w-0 items-center gap-1 text-xs text-text-muted">
						<Folder className="size-3 shrink-0" aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate">{projectName}</span>
					</div>
				</div>
				{metaNode}
			</div>
		) : (
			<div className="flex h-9 min-w-0 items-center gap-1.5 px-2">
				{presentation !== null && statusNode}
				{session.pinnedAt !== undefined && <Pin className="size-3 shrink-0 text-text-muted" aria-hidden="true" />}
				{titleNode}
				{queueNode}
				{metaNode}
			</div>
		);
	const primaryButton = (
		<button
			type="button"
			data-session-key={key}
			aria-current={isActive ? "page" : undefined}
			onClick={onSelect}
			onDoubleClick={onKeepOpen}
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
						"group/session relative isolate w-full overflow-hidden rounded-control border border-transparent text-left text-text-primary transition-[background-color]",
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
					{editing ? (
						<div className="w-full text-left">{rowContent}</div>
					) : presentation === null && queueNode === null ? (
						<Tooltip>
							<TooltipTrigger render={primaryButton} />
							<TooltipContent side="right">{activityLabel}</TooltipContent>
						</Tooltip>
					) : (
						primaryButton
					)}
					{!editing && variant === "active" && (
						<TooltipIconButton
							onClick={pinAction}
							label={t(session.pinnedAt !== undefined ? "session.ctxUnpin" : "session.ctxPin")}
							className={cn(
								"pointer-events-none absolute top-1/2 right-8 z-10 size-6 -translate-y-1/2 bg-transparent opacity-0 shadow-none group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 group-hover/session:pointer-events-auto group-hover/session:opacity-100",
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
							className="pointer-events-none absolute top-1/2 right-1 z-10 size-6 -translate-y-1/2 bg-transparent opacity-0 shadow-none group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 group-hover/session:pointer-events-auto group-hover/session:opacity-100"
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
