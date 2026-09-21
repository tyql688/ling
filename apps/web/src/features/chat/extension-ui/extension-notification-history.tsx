import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ExtensionUiStateSnapshot } from "@ling/contracts/session";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import { AlertCircle, AlertTriangle, ExternalLink, Info } from "lucide-react";
import { useTranslation } from "react-i18next";

const NOTIFICATION_URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

function splitNotificationMessage(
	message: string,
): Array<{ type: "text"; value: string } | { type: "url"; value: string }> {
	const parts: Array<{ type: "text"; value: string } | { type: "url"; value: string }> = [];
	let lastIndex = 0;
	for (const match of message.matchAll(NOTIFICATION_URL_PATTERN)) {
		const rawUrl = match[0];
		const index = match.index ?? 0;
		if (index > lastIndex) parts.push({ type: "text", value: message.slice(lastIndex, index) });
		const url = rawUrl.replace(/[.,;:!?]+$/, "");
		const trailing = rawUrl.slice(url.length);
		parts.push({ type: "url", value: url });
		if (trailing.length > 0) parts.push({ type: "text", value: trailing });
		lastIndex = index + rawUrl.length;
	}
	if (lastIndex < message.length) parts.push({ type: "text", value: message.slice(lastIndex) });
	return parts.length === 0 ? [{ type: "text", value: message }] : parts;
}

function NotificationMessage({
	message,
	onOpenLinkError,
}: {
	message: string;
	onOpenLinkError: (error: unknown) => void;
}) {
	const hostAppApi = useDomainApi("app");

	const { t } = useTranslation();
	return (
		<span className="min-w-0 whitespace-pre-wrap break-words">
			{splitNotificationMessage(message).map((part, index) => {
				const key = `${part.type}:${index}:${part.value}`;
				if (part.type === "text") return <span key={key}>{part.value}</span>;
				return (
					<Tooltip key={key}>
						<TooltipTrigger
							render={
								<button
									type="button"
									onClick={() => void hostAppApi.openExternal(part.value).catch(onOpenLinkError)}
									className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-sm px-1 text-text-primary underline decoration-border-strong underline-offset-2 transition-colors hover:bg-surface-hover"
								/>
							}
						>
							<span className="min-w-0 break-all">{part.value}</span>
							<ExternalLink className="size-3 shrink-0" aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent>{t("markdown.openExternalLink")}</TooltipContent>
					</Tooltip>
				);
			})}
		</span>
	);
}

export function ExtensionNotificationHistory({
	notifications,
	onOpenLinkError,
}: {
	notifications: ExtensionUiStateSnapshot["notifications"];
	onOpenLinkError: (error: unknown) => void;
}) {
	const { t, i18n } = useTranslation();
	const timeFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
		hour: "2-digit",
		minute: "2-digit",
	});
	return (
		<div
			role="log"
			aria-label={t("extensionUi.activity")}
			aria-relevant="additions"
			className="flex flex-col-reverse gap-1.5"
		>
			{notifications.map((notification, index) => {
				const Icon =
					notification.level === "error" ? AlertCircle : notification.level === "warning" ? AlertTriangle : Info;
				const timestamp = timeFormatter.format(notification.createdAt);
				const visualIndex = notifications.length - index - 1;
				return (
					<div
						key={notification.id}
						className={cn(
							"rounded-control border px-2.5 py-2",
							notification.level === "error"
								? "border-danger/20 bg-danger/8"
								: notification.level === "warning"
									? "border-warning/20 bg-warning/8"
									: "border-border-subtle bg-surface-raised/60",
							visualIndex > 0 && "opacity-80",
						)}
					>
						<div className="flex min-w-0 items-start gap-2">
							<Icon
								className={cn(
									"mt-0.5 size-3.5 shrink-0",
									notification.level === "error"
										? "text-danger"
										: notification.level === "warning"
											? "text-warning"
											: "text-text-muted",
								)}
								aria-hidden="true"
							/>
							<p className="min-w-0 flex-1 text-xs leading-relaxed text-text-primary/85">
								<NotificationMessage message={notification.message} onOpenLinkError={onOpenLinkError} />
							</p>
							<time
								dateTime={new Date(notification.createdAt).toISOString()}
								className="shrink-0 font-mono text-xs tabular-nums text-text-muted"
							>
								{timestamp}
							</time>
						</div>
					</div>
				);
			})}
		</div>
	);
}
