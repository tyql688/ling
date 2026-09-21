import { activeJobStatuses } from "@ling/contracts/background-tasks";
import type { SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { useFeatureNavigation } from "@renderer/components/workbench/feature-navigation";
import { SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBackgroundTasks } from "./use-background-tasks";

/** Composer badge with the number of running background tasks; opens the task page. */
export function BackgroundTasksProgress({ sessionRef }: { sessionRef: SessionRef }) {
	const { t } = useTranslation();
	const state = useBackgroundTasks(sessionRef);
	const openFeature = useFeatureNavigation();
	const active = state.value?.filter((job) => activeJobStatuses.has(job.status)).length ?? 0;
	if (!active) return null;
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 shrink-0 gap-1 px-1.5 text-xs font-normal text-text-muted hover:text-text-primary"
			onClick={() => openFeature("background-tasks")}
		>
			<SquareTerminal className="size-3.5" aria-hidden="true" />
			<span className="tabular-nums">
				{t("backgroundTasks.title")} {active}
			</span>
		</Button>
	);
}
