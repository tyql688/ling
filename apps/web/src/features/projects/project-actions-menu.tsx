import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionSummary } from "@ling/contracts/session";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
	Archive,
	Code2,
	Copy,
	Ellipsis,
	FolderOpen,
	GitBranch,
	GitCompareArrows,
	Pencil,
	Pin,
	SquarePen,
	SquareTerminal,
	X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/** Historical session groups have no live directory inspection until their project is opened. */
export type ProjectActionTarget =
	| { project: OpenProjectInfo; projectOpen: true }
	| { project: Omit<OpenProjectInfo, "availability"> & { availability?: never }; projectOpen: false };

type ProjectActionsProps = ProjectActionTarget & {
	pinned: boolean;
	sessions: readonly SessionSummary[];
	onNewSession: (cwd: string) => void;
	onTogglePinned: (cwd: string) => void;
	onRename: (cwd: string, currentName: string) => void;
	onArchiveSessions: (sessions: readonly SessionSummary[]) => void;
	onCreateWorktree: (project: OpenProjectInfo) => void;
	onRemoveWorktree: (project: OpenProjectInfo) => void;
	onReveal: (cwd: string) => void;
	onShowChanges: (project: OpenProjectInfo) => void;
	onOpenEditor: (cwd: string) => void;
	onOpenTerminal: (cwd: string) => void;
	onCopyPath: (cwd: string) => void;
	onRemoveProject: () => void;
};

type ProjectActionsMenuProps = ProjectActionsProps & {
	trigger?: ReactElement | undefined;
	onOpenChange?: ((open: boolean) => void) | undefined;
};

type ProjectActionsContextMenuProps = ProjectActionsProps & {
	trigger: ReactElement;
	onOpenChange?: ((open: boolean) => void) | undefined;
};

type ProjectAction =
	| { kind: "separator"; key: string }
	| {
			kind: "item";
			key: string;
			label: string;
			icon: ReactElement;
			disabled: boolean;
			variant: "default" | "destructive";
			onSelect: () => void;
	  };

function useProjectActions({
	project,
	projectOpen,
	pinned,
	sessions,
	onNewSession,
	onTogglePinned,
	onRename,
	onArchiveSessions,
	onCreateWorktree,
	onRemoveWorktree,
	onReveal,
	onShowChanges,
	onOpenEditor,
	onOpenTerminal,
	onCopyPath,
	onRemoveProject,
}: ProjectActionsProps): ProjectAction[] {
	const { t } = useTranslation();
	const canArchiveSessions = sessions.some((session) => session.archivedAt === undefined);
	const actions: ProjectAction[] = [];
	const addItem = (
		key: string,
		label: string,
		icon: ReactElement,
		onSelect: () => void,
		disabled = false,
		variant: "default" | "destructive" = "default",
	) => actions.push({ kind: "item", key, label, icon, onSelect, disabled, variant });
	const addSeparator = (key: string) => actions.push({ kind: "separator", key });

	if (projectOpen) {
		addItem("new-session", t("session.new"), <SquarePen aria-hidden="true" />, () => onNewSession(project.cwd));
		addItem(
			"show-changes",
			t("project.showChanges"),
			<GitCompareArrows aria-hidden="true" />,
			() => onShowChanges(project),
			sessions.length === 0,
		);
		addSeparator("launch-separator");
		addItem("open-editor", t("project.openInEditor"), <Code2 aria-hidden="true" />, () => onOpenEditor(project.cwd));
		addItem("reveal", t("project.showInFileManager"), <FolderOpen aria-hidden="true" />, () => onReveal(project.cwd));
		addItem("open-terminal", t("project.openInExternalTerminal"), <SquareTerminal aria-hidden="true" />, () =>
			onOpenTerminal(project.cwd),
		);
	}

	addItem("copy-path", t("project.copyPath"), <Copy aria-hidden="true" />, () => onCopyPath(project.cwd));

	if (projectOpen) {
		addSeparator("resources-separator");
		addItem("create-worktree", t("worktree.createPermanent"), <GitBranch aria-hidden="true" />, () =>
			onCreateWorktree(project),
		);
	}

	addSeparator("manage-separator");
	addItem("toggle-pin", t(pinned ? "project.unpin" : "project.pin"), <Pin aria-hidden="true" />, () =>
		onTogglePinned(project.cwd),
	);
	addItem("rename", t("project.rename"), <Pencil aria-hidden="true" />, () => onRename(project.cwd, project.name));
	addItem(
		"archive",
		t("project.archiveChats"),
		<Archive aria-hidden="true" />,
		() => onArchiveSessions(sessions),
		!canArchiveSessions,
	);

	if (projectOpen) {
		addSeparator("remove-separator");
		if (project.meta.kind === "worktree") {
			addItem(
				"remove-worktree",
				t("worktree.remove"),
				<X aria-hidden="true" />,
				() => onRemoveWorktree(project),
				false,
				"destructive",
			);
		} else {
			addItem("remove-project", t("project.remove"), <X aria-hidden="true" />, onRemoveProject, false, "destructive");
		}
	}

	return actions;
}

function DropdownProjectActionItems({ actions }: { actions: readonly ProjectAction[] }) {
	return actions.map((action) =>
		action.kind === "separator" ? (
			<DropdownMenuSeparator key={action.key} />
		) : (
			<DropdownMenuItem key={action.key} disabled={action.disabled} variant={action.variant} onSelect={action.onSelect}>
				{action.icon}
				{action.label}
			</DropdownMenuItem>
		),
	);
}

function ContextProjectActionItems({ actions }: { actions: readonly ProjectAction[] }) {
	return actions.map((action) =>
		action.kind === "separator" ? (
			<ContextMenuSeparator key={action.key} />
		) : (
			<ContextMenuItem key={action.key} disabled={action.disabled} variant={action.variant} onSelect={action.onSelect}>
				{action.icon}
				{action.label}
			</ContextMenuItem>
		),
	);
}

export function ProjectActionsMenu(props: ProjectActionsMenuProps) {
	const { t } = useTranslation();
	const { trigger, onOpenChange } = props;
	const actions = useProjectActions(props);
	const menuTrigger = trigger ?? (
		<button
			type="button"
			aria-label={t("project.moreActions")}
			data-dialog-focus-fallback=""
			className="flex size-8 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
		>
			<Ellipsis className="size-4" aria-hidden="true" />
		</button>
	);

	return (
		<DropdownMenu {...(onOpenChange === undefined ? {} : { onOpenChange })}>
			<DropdownMenuTrigger render={menuTrigger} />
			<DropdownMenuContent className="w-52">
				<DropdownProjectActionItems actions={actions} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Project row context menu: shares the same actions and disabled rules as the ellipsis menu. */
export function ProjectActionsContextMenu({ trigger, onOpenChange, ...props }: ProjectActionsContextMenuProps) {
	const actions = useProjectActions(props);
	return (
		<ContextMenu {...(onOpenChange === undefined ? {} : { onOpenChange })}>
			<ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
			<ContextMenuContent className="w-52">
				<ContextProjectActionItems actions={actions} />
			</ContextMenuContent>
		</ContextMenu>
	);
}
