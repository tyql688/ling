import type { SkillInfo } from "@ling/contracts/skill";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { SettingsCollection } from "@renderer/components/ui/settings-list";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";
import { GraduationCap, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkillScopeBadges } from "./skill-scope-badges";

/** Row switches for Ling's per-skill load toggles; absent means read-only rows. */
export interface SkillRowToggle {
	onToggle: (skill: SkillInfo, enabled: boolean) => void;
	busy: boolean;
	/** Force-disable every switch in this list (e.g. built-in master switched off). */
	disabled?: boolean;
}

export function SkillRows({
	skills,
	onSelect,
	selectedPath,
	onUse,
	embedded = false,
	compact = false,
	tree = false,
	rowClassName,
	toggle,
}: {
	skills: readonly SkillInfo[];
	onSelect: (skill: SkillInfo) => void;
	selectedPath?: string | undefined;
	/** Offers the row a right-click "use" action; omitted where there is no composer to write into. */
	onUse?: (skill: SkillInfo) => void;
	embedded?: boolean;
	compact?: boolean;
	tree?: boolean;
	rowClassName?: string;
	toggle?: SkillRowToggle;
}) {
	const { t } = useTranslation();
	const rows = (
		<>
			{skills.map((skill) => {
				const dimmed = toggle !== undefined && (!skill.enabled || toggle.disabled === true);
				const row = (
					<div className={cn("flex w-full items-center", toggle && "pr-4")}>
						<button
							type="button"
							title={tree ? `${skill.name}\n${skill.description}` : undefined}
							onClick={() => onSelect(skill)}
							aria-current={selectedPath === skill.filePath ? "page" : undefined}
							className={cn(
								"flex min-w-0 flex-1 items-center gap-3 px-4 text-left transition-colors hover:bg-surface-hover/50 focus-visible:bg-surface-hover/50",
								tree ? "min-h-7 gap-2 py-1 px-2" : compact ? "py-2.5" : "py-3",
								dimmed && "opacity-50",
								selectedPath === skill.filePath && "bg-surface-hover",
								rowClassName,
							)}
						>
							<div
								className={
									tree
										? "shrink-0"
										: "flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-hover"
								}
							>
								<GraduationCap className="size-4 text-text-muted" aria-hidden="true" />
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<span className={cn("truncate text-text-primary", tree ? "text-xs" : "text-sm font-medium")}>
										{skill.name}
									</span>
									{!tree && <SkillScopeBadges skill={skill} />}
								</div>
								{!tree && (
									<p className={cn("mt-0.5 text-xs text-text-muted", compact ? "line-clamp-1" : "line-clamp-2")}>
										{skill.description}
									</p>
								)}
							</div>
						</button>
						{toggle && (
							<Switch
								aria-label={skill.name}
								checked={skill.enabled}
								disabled={toggle.busy || toggle.disabled === true}
								onCheckedChange={(enabled) => toggle.onToggle(skill, enabled)}
							/>
						)}
					</div>
				);
				if (!onUse) return <div key={skill.filePath}>{row}</div>;
				return (
					<ContextMenu key={skill.filePath}>
						<ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem onClick={() => onUse(skill)}>
								<Wand2 aria-hidden="true" />
								{t("skills.use")}
							</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
				);
			})}
		</>
	);
	return embedded ? rows : <SettingsCollection>{rows}</SettingsCollection>;
}
