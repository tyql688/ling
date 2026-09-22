import type { ProviderQuota, ProviderQuotaSnapshot, ProviderQuotaWindow } from "@ling/contracts/usage";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { DisclosureRow } from "@renderer/components/ui/disclosure-row";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { ProviderGlyph } from "@renderer/features/models/provider-glyph";
import { cn } from "@renderer/lib/utils";
import { AlertCircle, CircleAlert, Gauge, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { preferredQuotaWindow } from "./quota-summary";
import { formatUsageTime } from "./usage-format";
import {
	amountLabel,
	formatAmount,
	humanize,
	providerError,
	quotaCount,
	quotaPercent,
	quotaProgressColorClass,
	quotaUsedProgressPercent,
	quotaWindowTitle,
	PROVIDER_QUOTA_WARNING_USED_PERCENT,
} from "./provider-quota-format";

export interface ProviderQuotaState {
	snapshot: ProviderQuotaSnapshot | null;
	loading: boolean;
	error: boolean;
}

function QuotaMeter({
	window,
	title,
	decorative = false,
}: {
	window: ProviderQuotaWindow;
	title: string;
	decorative?: boolean;
}) {
	const { t } = useTranslation();
	const progress = quotaUsedProgressPercent(window);
	if (progress === null) return null;
	return (
		<span
			role="progressbar"
			aria-hidden={decorative || undefined}
			aria-label={title}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={progress}
			aria-valuetext={quotaPercent(window, t) ?? undefined}
			className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-hover"
		>
			<span
				className={cn(
					"block h-full origin-left rounded-full transition-transform duration-200 motion-reduce:transition-none",
					progress < PROVIDER_QUOTA_WARNING_USED_PERCENT ? "bg-accent/75" : quotaProgressColorClass(progress),
				)}
				style={{ transform: `scaleX(${progress / 100})` }}
			/>
		</span>
	);
}

function ProviderQuotaRow({ provider }: { provider: ProviderQuota }) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	const window = preferredQuotaWindow(provider.windows) ?? provider.windows[0];
	const amount = provider.amounts[0];
	const summary = window ? quotaPercent(window, t) : amount ? formatAmount(amount, language, t) : null;
	const windowTitle = window ? quotaWindowTitle(window, t) : amount ? amountLabel(amount, t) : null;
	const description = [provider.plan ? humanize(provider.plan) : null, windowTitle].filter(Boolean).join(" · ");
	if (provider.status === "error" || (provider.windows.length === 0 && provider.amounts.length === 0)) {
		return (
			<article className="flex items-start gap-2.5 px-4 py-3">
				<ProviderGlyph provider={provider.id} size={20} className="mt-0.5 shrink-0" />
				<div className="min-w-0 flex-1">
					<h3 className="text-sm font-medium text-text-primary">{provider.name}</h3>
					{provider.plan && <p className="mt-0.5 text-xs text-text-muted">{humanize(provider.plan)}</p>}
					<p
						role={provider.status === "error" ? "alert" : undefined}
						className={cn(
							"mt-1 text-xs leading-relaxed",
							provider.status === "error" ? "text-danger" : "text-text-muted",
						)}
					>
						{provider.status === "error" ? providerError(provider.error, t) : t("usage.providerQuotaNoData")}
					</p>
				</div>
				{provider.status === "error" && (
					<CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-label={t("usage.providerQuotaError")} />
				)}
			</article>
		);
	}
	return (
		<DisclosureRow
			icon={
				<span className="block">
					<ProviderGlyph provider={provider.id} size={20} />
				</span>
			}
			title={provider.name}
			description={
				<span className="block truncate" title={description}>
					{description}
				</span>
			}
			summary={
				<span className="block min-w-20 break-words">
					<span className="font-medium text-text-primary">{summary ?? "—"}</span>
					{window && <QuotaMeter window={window} title={windowTitle ?? provider.name} decorative />}
				</span>
			}
		>
			<div className="space-y-3 border-l border-border-subtle pl-3 sm:ml-7">
				{provider.windows.map((window) => {
					const title = quotaWindowTitle(window, t);
					const count = quotaCount(window, language, t);
					return (
						<div key={window.id}>
							<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
								<span className="font-medium text-text-primary">{title}</span>
								<span className="tabular-nums text-text-muted">{quotaPercent(window, t) ?? "—"}</span>
							</div>
							<QuotaMeter window={window} title={title} />
							{(count || window.resetAt !== null) && (
								<div className="mt-1.5 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
									{count && <span>{count}</span>}
									{window.resetAt !== null && (
										<span>
											{t("usage.providerQuotaReset", { time: formatUsageTime(window.resetAt, language, true) })}
										</span>
									)}
								</div>
							)}
						</div>
					);
				})}
				{provider.amounts.length > 0 && (
					<dl className="divide-y divide-border-subtle">
						{provider.amounts.map((amount) => (
							<div
								key={`${amount.kind}-${amount.period ?? "none"}-${amount.unit}`}
								className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-xs first:pt-0 last:pb-0"
							>
								<dt className="text-text-muted">{amountLabel(amount, t)}</dt>
								<dd className="font-medium tabular-nums text-text-primary">{formatAmount(amount, language, t)}</dd>
							</div>
						))}
					</dl>
				)}
			</div>
		</DisclosureRow>
	);
}

export function ProviderQuotaDialog({
	open,
	onOpenChange,
	state,
	onRefresh,
	onConfigure,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	state: ProviderQuotaState;
	onRefresh(): Promise<void>;
	onConfigure(): void;
}) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	const visibleQuotaProviders = state.snapshot?.providers.filter((provider) => provider.status !== "unsupported") ?? [];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				id="provider-quota-dialog"
				size="medium"
				className="flex max-h-[min(42rem,calc(100dvh-2rem))] max-w-[40rem] flex-col overflow-hidden p-0"
			>
				<header className="flex h-11 shrink-0 items-center border-b border-border-subtle px-4 pr-12">
					<DialogTitle className="flex items-center gap-2">
						<Gauge className="size-4 text-accent" aria-hidden="true" />
						{t("usage.providerQuotaDialogTitle")}
					</DialogTitle>
					<DialogDescription className="sr-only">{t("usage.providerQuotaDescription")}</DialogDescription>
				</header>
				<DialogCloseButton className="top-2 right-2" aria-label={t("usage.providerQuotaClose")} />
				<div className="min-h-0 flex-1 overflow-y-auto py-1" aria-busy={state.loading}>
					{state.error && state.snapshot && (
						<FeedbackNotice tone="danger" title={t("usage.providerQuotaRefreshFailed")} className="mx-4 my-3">
							{t("usage.providerQuotaRefreshFailedDescription")}
						</FeedbackNotice>
					)}
					{state.snapshot ? (
						visibleQuotaProviders.length > 0 ? (
							<div className="divide-y divide-border-subtle">
								{visibleQuotaProviders.map((provider) => (
									<ProviderQuotaRow key={provider.id} provider={provider} />
								))}
							</div>
						) : (
							<SettingsState
								className="rounded-none border-0 bg-transparent"
								compact
								icon={Gauge}
								title={t("usage.providerQuotaEmpty")}
								description={t("usage.providerQuotaEmptyDescription")}
								action={
									<Button size="sm" onClick={onConfigure}>
										{t("usage.providerQuotaConfigure")}
									</Button>
								}
							/>
						)
					) : state.loading ? (
						<LoadingTransition className="min-h-52" label={t("usage.providerQuotaLoading")} />
					) : (
						<SettingsState
							className="rounded-none border-0 bg-transparent"
							compact
							icon={AlertCircle}
							tone="danger"
							title={t("usage.providerQuotaUnavailable")}
							description={t("usage.providerQuotaUnavailableDescription")}
							action={<SettingsRetryAction label={t("usage.retry")} onClick={() => void onRefresh()} />}
						/>
					)}
				</div>
				<footer className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-t border-border-subtle px-4 py-1.5">
					<p className="truncate text-xs text-text-muted">
						{state.snapshot
							? t("usage.providerQuotaUpdated", { time: formatUsageTime(state.snapshot.generatedAt, language) })
							: t("usage.providerQuotaNotUpdated")}
					</p>
					<Button variant="outline" size="sm" disabled={state.loading} onClick={() => void onRefresh()}>
						<RefreshCw
							className={cn("size-3.5", state.loading && "animate-spin motion-reduce:animate-none")}
							aria-hidden="true"
						/>
						{t("usage.providerQuotaRefresh")}
					</Button>
				</footer>
			</DialogContent>
		</Dialog>
	);
}
