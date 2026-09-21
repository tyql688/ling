import type { SessionMessage } from "@ling/contracts/session-messages";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { Box, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type ModelRef, modelRefLabel, previousModelRef } from "./model-change-events";

function sameModelRef(left: ModelRef | null, right: ModelRef): boolean {
	return left?.provider === right.provider && left.modelId === right.modelId;
}

export function ModelChangeDivider({
	message,
	messages,
	index,
}: {
	message: Extract<SessionMessage, { role: "modelChange" }>;
	messages: SessionMessage[];
	index: number;
}) {
	const { t } = useTranslation();
	const current = { provider: message.provider, modelId: message.modelId };
	const previous = previousModelRef(messages, index);
	const hasPrevious = previous !== null && !sameModelRef(previous, current);
	const label = hasPrevious
		? t("session.modelChanged", {
				from: modelRefLabel(previous, current),
				to: modelRefLabel(current, previous),
			})
		: t("session.modelChangedTo", { to: modelRefLabel(current) });

	return (
		<div className="flex items-center gap-3 text-sm font-medium text-text-muted">
			<span className="h-px min-w-6 flex-1 bg-border-subtle" aria-hidden="true" />
			<div className="flex min-w-0 items-center gap-2 text-center">
				<Box className="size-4 shrink-0" aria-hidden="true" />
				<span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								className="flex size-6 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
								aria-label={t("session.modelChangeInfo")}
							/>
						}
					>
						<Info className="size-3.5" aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent className="max-w-[17rem] text-center text-sm leading-relaxed">
						{t("session.modelChangeInfo")}
					</TooltipContent>
				</Tooltip>
			</div>
			<span className="h-px min-w-6 flex-1 bg-border-subtle" aria-hidden="true" />
		</div>
	);
}
