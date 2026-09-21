import type { ApprovalRequest } from "@ling/contracts/session";
import { Button } from "@renderer/components/ui/button";
import { InteractionCard, InteractionChoice } from "@renderer/components/ui/interaction-card";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { formatRequestError } from "@renderer/lib/errors";
import { Clock3, ShieldCheck } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TerminalText } from "./terminal-text";
import { useRemainingSeconds } from "./use-remaining-seconds";

interface ApprovalPromptCardProps {
	request: ApprovalRequest;
	pendingCount: number;
	onRespond: (approved: boolean) => Promise<void>;
}

/** Pi's ctx.ui.confirm projected into the active conversation. Ling presents the request and
 * returns the user's boolean decision; approval policy remains entirely extension-owned. */
export function ApprovalPromptCard({ request, pendingCount, onRespond }: ApprovalPromptCardProps) {
	const { t } = useTranslation();
	const [responding, setResponding] = useState(false);
	const submitting = useRef(false);
	const [selected, setSelected] = useState<boolean | null>(null);
	const [error, setError] = useState<string | null>(null);
	const remainingSeconds = useRemainingSeconds(request.expiresAt);

	const respond = useCallback(
		async (approved: boolean) => {
			if (submitting.current) return false;
			submitting.current = true;
			setResponding(true);
			setError(null);
			try {
				await onRespond(approved);
				return true;
			} catch (cause) {
				submitting.current = false;
				setError(formatRequestError(cause));
				setResponding(false);
				return false;
			}
		},
		[onRespond],
	);

	return (
		<InteractionCard
			label={t("approval.requestLabel")}
			title={<TerminalText value={request.title} />}
			icon={<ShieldCheck className="size-4" />}
			meta={pendingCount > 1 ? t("approval.pendingCount", { count: pendingCount }) : undefined}
			hint={
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<p>{t("extensionUi.selectConfirmHint")}</p>
					{remainingSeconds !== null && (
						<span className="inline-flex items-center gap-1 tabular-nums">
							<Clock3 className="size-3.5" aria-hidden="true" />
							{t("approval.expiresIn", { count: remainingSeconds })}
						</span>
					)}
				</div>
			}
			footer={
				<>
					<Button variant="ghost" size="sm" disabled={responding} onClick={() => void respond(false)}>
						{t("extensionUi.cancel")}
					</Button>
					<Button
						size="sm"
						disabled={responding || selected === null}
						onClick={() => selected !== null && void respond(selected)}
					>
						{t("extensionUi.confirmSelection")}
					</Button>
				</>
			}
		>
			<pre className="attention-prompt-card-detail min-w-0 whitespace-pre-wrap rounded-control px-3 py-2 font-mono text-xs leading-relaxed text-text-primary [overflow-wrap:anywhere]">
				<TerminalText value={request.message} />
			</pre>
			<div className="grid gap-1.5" role="radiogroup" aria-label={request.title}>
				{[true, false].map((value) => (
					<InteractionChoice
						key={String(value)}
						name={request.requestId}
						value={String(value)}
						selected={selected === value}
						disabled={responding}
						onSelect={() => setSelected(value)}
						onConfirm={() => void respond(value)}
					>
						{t(value ? "approval.approve" : "approval.deny")}
					</InteractionChoice>
				))}
			</div>
			{error !== null && (
				<FeedbackNotice tone="danger" className="text-xs">
					<span className="break-words">{error}</span>
				</FeedbackNotice>
			)}
		</InteractionCard>
	);
}
