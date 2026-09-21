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
	onUse,
	embedded = false,
	compact = false,
	rowClassName,
	toggle,
}: {
	skills: readonly SkillInfo[];
	onSelect: (skill: SkillInfo) => void;
	/** Offers the row a right-click "use" action; omitted where there is no composer to write into. */
	onUse?: (skill: SkillInfo) => void;
	embedded?: boolean;
	compact?: boolean;
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
							onClick={() => onSelect(skill)}
							className={cn(
								"flex min-w-0 flex-1 items-center gap-3 px-4 text-left transition-colors hover:bg-surface-hover/50 focus-visible:bg-surface-hover/50",
								compact ? "py-2.5" : "py-3",
								dimmed && "opacity-50",
								rowClassName,
							)}
						>
							<div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-hover">
								<GraduationCap className="size-4 text-text-muted" aria-hidden="true" />
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<span className="truncate text-sm font-medium text-text-primary">{skill.name}</span>
									<SkillScopeBadges skill={skill} />
								</div>
								<p className={cn("mt-0.5 text-xs text-text-muted", compact ? "line-clamp-1" : "line-clamp-2")}>
									{skill.description}
								</p>
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
