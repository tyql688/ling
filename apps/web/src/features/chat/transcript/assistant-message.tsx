import type { SessionMessage } from "@ling/contracts/session-messages";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card";
import { formatClock, formatCost } from "@renderer/lib/format";
import { useTranslation } from "react-i18next";
import { AssistantContent } from "./assistant-render";
import { MessageActions } from "./message-actions";
import { partsText } from "./message-text";

type Assistant = Extract<SessionMessage, { role: "assistant" }>;

function MessageUsage({ message }: { message: Assistant }) {
	const { t } = useTranslation();
	const usage = message.usage;
	if (!usage)
		return message.timestamp ? <time className="text-xs text-text-muted">{formatClock(message.timestamp)}</time> : null;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const rows = [
		[t("session.usageInput"), usage.input.toLocaleString()],
		[t("session.usageOutput"), usage.output.toLocaleString()],
		[
			t("session.usageSpeed"),
			message.generationDurationMs === undefined
				? "—"
				: `${((usage.output * 1_000) / message.generationDurationMs).toLocaleString(undefined, { maximumFractionDigits: 1 })} token/s`,
		],
		[t("session.usageCacheRead"), usage.cacheRead.toLocaleString()],
		[t("session.usageCacheWrite"), usage.cacheWrite.toLocaleString()],
		[t("session.usageCacheHit"), prompt === 0 ? "—" : `${((usage.cacheRead / prompt) * 100).toFixed(1)}%`],
		[t("session.usageCost"), usage.cost ? formatCost(usage.cost.total) : "—"],
	];
	return (
		<HoverCard>
			<HoverCardTrigger
				render={
					<button
						type="button"
						className="min-h-7 rounded-control px-2 text-xs tabular-nums text-text-muted hover:bg-surface-hover"
						aria-label={t("session.usageLabel")}
					/>
				}
			>
				{t("session.usageLabel")}
				{usage.cost && ` · ${formatCost(usage.cost.total)}`}
			</HoverCardTrigger>
			<HoverCardContent side="top" className="w-64">
				<dl className="space-y-2">
					{rows.map(([label, value]) => (
						<div key={label} className="flex justify-between gap-4 text-xs">
							<dt className="text-text-muted">{label}</dt>
							<dd className="tabular-nums">{value}</dd>
						</div>
					))}
				</dl>
			</HoverCardContent>
		</HoverCard>
	);
}

interface AssistantMessageProps {
	message: Assistant;
	streaming: boolean;
	busy: boolean;
	showError: boolean;
	onFork(entryId: string): void;
}

export function AssistantMessage(props: AssistantMessageProps) {
	return (
		<div className="group min-w-0">
			<AssistantContent content={props.message.content} streaming={props.streaming} />
			<AssistantMessageDetails {...props} />
		</div>
	);
}

export function AssistantMessageDetails({ message, streaming, busy, showError, onFork }: AssistantMessageProps) {
	const { t } = useTranslation();
	const text = partsText(message.content);
	return (
		<>
			{showError && (
				<FeedbackNotice tone="danger" className="mt-1 text-xs">
					{message.errorMessage ?? t("session.turnError")}
				</FeedbackNotice>
			)}
			{message.stopReason === "aborted" && (
				<p className="mt-1 text-xs italic text-text-muted">{t("session.turnAborted")}</p>
			)}
			{text.length > 0 && !streaming && (
				<div className="mt-1 flex items-center gap-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
					<MessageActions
						text={text}
						actionsDisabled={busy}
						alwaysVisible
						onFork={
							message.entryId === null
								? undefined
								: () => {
										if (message.entryId !== null) onFork(message.entryId);
									}
						}
					/>
					<MessageUsage message={message} />
				</div>
			)}
		</>
	);
}
