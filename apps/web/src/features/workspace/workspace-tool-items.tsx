import { shortcut } from "@renderer/lib/platform";
import { AlertCircle, Blocks, FileCog, Files, GitCompareArrows, GraduationCap } from "lucide-react";
import type { ReactNode } from "react";
import type { useTranslation } from "react-i18next";

/** One directly selectable workspace tool. */
interface WorkspaceToolItem {
	id: string;
	/** Stable destination name for the tool launcher; label describes the current action. */
	title: string;
	label: string;
	shortcut?: string | undefined;
	icon: ReactNode;
	/** Count badge; hidden when 0. */
	count?: number | undefined;
	danger?: boolean | undefined;
	disabled?: boolean | undefined;
	onSelect: () => void;
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** Badge ceiling: bound narrow menus so large counts do not displace their labels. */
const MAX_VISIBLE_TOOL_COUNT = 99;

export function formatWorkspaceToolCount(count: number): string {
	return count > MAX_VISIBLE_TOOL_COUNT ? `${MAX_VISIBLE_TOOL_COUNT}+` : count.toString();
}

/** Built-in workspace tools in their stable menu order. */
export function builtinWorkspaceTools(input: {
	t: Translate;
	explorer: { open: boolean; toggle: () => void };
	review: { open: boolean; count: number; error: boolean; toggle: () => void; refresh: () => void };
	piConfig: { toggle: () => void };
	skills: (() => void) | undefined;
	dock: { open: boolean; count: number; toggle: () => void } | null;
	/** No active project: every tool stays visible for layout stability but inert. */
	disabled?: boolean | undefined;
}): WorkspaceToolItem[] {
	const { t, explorer, review, piConfig, skills, dock, disabled } = input;
	const items: WorkspaceToolItem[] = [
		{
			id: "review",
			title: t("changes.toolbarLabel"),
			label: review.error
				? t("changes.refresh")
				: review.open
					? t("changes.close")
					: t("changes.open", { count: review.count }),
			icon: review.error ? (
				<AlertCircle className="size-4" aria-hidden="true" />
			) : (
				<GitCompareArrows className="size-4" aria-hidden="true" />
			),
			count: review.count,
			danger: review.error,
			onSelect: review.error ? review.refresh : review.toggle,
		},
		{
			id: "explorer",
			title: t("explorer.title"),
			label: explorer.open ? t("explorer.close") : t("explorer.open"),
			shortcut: shortcut("Shift+E"),
			icon: <Files className="size-4" aria-hidden="true" />,
			onSelect: explorer.toggle,
		},
	];
	items.push({
		id: "piConfig",
		title: t("projectPiConfig.toolbarLabel"),
		label: t("projectPiConfig.toolbarLabel"),
		icon: <FileCog className="size-4" aria-hidden="true" />,
		onSelect: piConfig.toggle,
	});
	if (skills) {
		items.push({
			id: "skills",
			title: t("skills.title"),
			label: t("skills.title"),
			icon: <GraduationCap className="size-4" aria-hidden="true" />,
			onSelect: skills,
		});
	}
	if (dock) {
		items.push({
			id: "dock",
			title: t("extensionUi.dockTitle"),
			label: dock.open
				? t("extensionUi.closeDock")
				: dock.count > 0
					? t("extensionUi.openDockWithCount", { count: dock.count })
					: t("extensionUi.openDock"),
			icon: <Blocks className="size-4" aria-hidden="true" />,
			count: dock.count,
			onSelect: dock.toggle,
		});
	}
	if (disabled) {
		for (const item of items) item.disabled = true;
	}
	return items;
}
