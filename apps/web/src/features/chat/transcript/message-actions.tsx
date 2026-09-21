import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { COPY_CHECK_CLASS, useCopyFeedback } from "@renderer/hooks/use-copy-feedback";
import { cn } from "@renderer/lib/utils";
import { Check, Copy, GitFork } from "lucide-react";
import { useTranslation } from "react-i18next";

interface MessageActionsProps {
	text: string;
	onFork?: (() => void) | undefined;
	actionsDisabled: boolean;
	/** Latest actions stay visible; historical actions appear on hover or focus. */
	alwaysVisible?: boolean;
}

export function MessageActions({ text, onFork, actionsDisabled, alwaysVisible = false }: MessageActionsProps) {
	const { t } = useTranslation();
	const onError = useCommandFeedback();
	const { copiedKey: copied, markCopied } = useCopyFeedback<true>();
	const copyLabel = copied ? t("session.copied") : t("session.copy");
	const copy = async () => {
		await navigator.clipboard.writeText(text);
		markCopied(true);
	};

	return (
		<div
			className={cn(
				"flex w-fit items-center gap-0.5 transition-opacity duration-150",
				alwaysVisible
					? "opacity-100"
					: "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
			)}
		>
			<TooltipIconButton
				tooltipSide="bottom"
				label={copyLabel}
				className={copied ? "text-text-primary" : undefined}
				onClick={() => {
					void copy().catch(onError);
				}}
			>
				{copied ? (
					<Check className={cn("size-3.5", COPY_CHECK_CLASS)} strokeWidth={2} aria-hidden="true" />
				) : (
					<Copy className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
				)}
			</TooltipIconButton>
			{onFork ? (
				<TooltipIconButton tooltipSide="bottom" label={t("session.fork")} disabled={actionsDisabled} onClick={onFork}>
					<GitFork className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
				</TooltipIconButton>
			) : null}
		</div>
	);
}
