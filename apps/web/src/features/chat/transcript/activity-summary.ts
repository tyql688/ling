import type { TFunction } from "i18next";
import type { ToolCategory } from "./transcript-activity-model";

export function activitySummary(counts: Record<ToolCategory, number>, t: TFunction): string {
	return (Object.keys(counts) as ToolCategory[])
		.filter((key) => counts[key] > 0)
		.map((key) => t(`session.activity_${key}`, { count: counts[key] }))
		.join(" · ");
}
