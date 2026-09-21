import { formatCompactNumber } from "@renderer/lib/format-number";
import { preferredQuotaWindow } from "./quota-summary";
import { errorMessage } from "@ling/contracts/ling-error";
import type {
	ProviderQuota,
	ProviderQuotaAmount,
	ProviderQuotaErrorCode,
	ProviderQuotaSnapshot,
	ProviderQuotaWindow,
} from "@ling/contracts/usage";
import { AnimatedNumber } from "@renderer/components/ui/animated-number";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { STATUS_PRESENTATION } from "@renderer/components/ui/status-presentation";
import { ProviderGlyph } from "@renderer/features/models/provider-glyph";
import { showTodayUsageAtom } from "@renderer/features/usage/preferences";
import { formatUsageTime } from "@renderer/features/usage/usage-format";
import { formatCost } from "@renderer/lib/format";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { appModeAtom, settingsCategoryAtom } from "@renderer/lib/navigation-state";
import { cn } from "@renderer/lib/utils";
import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, ChartColumn, ChevronRight, CircleAlert, Gauge, RefreshCw, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./session-usage.css";

interface ProviderQuotaState {
	snapshot: ProviderQuotaSnapshot | null;
	loading: boolean;
	error: boolean;
}

const EMPTY_QUOTA_STATE: ProviderQuotaState = { snapshot: null, loading: false, error: false };
/** Provider account data refreshes every five minutes while the app is visible. */
const PROVIDER_QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000;
/** A one-minute check keeps focus-triggered refreshes bounded without drifting far past the refresh interval. */
const PROVIDER_QUOTA_REFRESH_CHECK_INTERVAL_MS = 60_000;
/** Rotate account summaries every four seconds; hover, focus, an open dialog and reduced motion pause rotation. */
const PROVIDER_QUOTA_ROTATION_INTERVAL_MS = 4_000;
/** At 70% used, quota bars turn orange to flag shrinking headroom. */
const PROVIDER_QUOTA_WARNING_USED_PERCENT = 70;
/** At 90% used, quota bars turn red to flag imminent exhaustion. */
const PROVIDER_QUOTA_DANGER_USED_PERCENT = 90;
/** Duration formatting uses exact provider seconds rather than assuming fixed quota windows. */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;

function formatCount(value: number, language: string): string {
	return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
}

function humanize(value: string): string {
	const text = value.replaceAll(/[_-]+/gu, " ").trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

function formatDuration(seconds: number, t: TFunction): string {
	if (seconds % SECONDS_PER_WEEK === 0) return t("usage.providerQuotaWeeks", { count: seconds / SECONDS_PER_WEEK });
	if (seconds % SECONDS_PER_DAY === 0) return t("usage.providerQuotaDays", { count: seconds / SECONDS_PER_DAY });
	if (seconds % SECONDS_PER_HOUR === 0) return t("usage.providerQuotaHours", { count: seconds / SECONDS_PER_HOUR });
	if (seconds % SECONDS_PER_MINUTE === 0)
		return t("usage.providerQuotaMinutes", { count: seconds / SECONDS_PER_MINUTE });
	return t("usage.providerQuotaSeconds", { count: seconds });
}

function quotaWindowTitle(window: ProviderQuotaWindow, t: TFunction): string {
	const duration = window.durationSeconds === null ? null : formatDuration(window.durationSeconds, t);
	const label = window.label
		? humanize(window.label)
		: window.kind === "model"
			? t("usage.providerQuotaModelLimit")
			: null;
	if (label) return duration ? `${label} · ${duration}` : label;
	if (duration) return duration;
	switch (window.kind) {
		case "weekly":
			return t("usage.providerQuotaWeekly");
		case "premium":
			return t("usage.providerQuotaPremium");
		case "chat":
			return t("usage.providerQuotaChat");
		default:
			return t("usage.providerQuotaLimit");
	}
}

function quotaUsedProgressPercent(window: ProviderQuotaWindow): number | null {
	if (window.unlimited || window.usedPercent === null) return null;
	return Math.max(0, Math.min(100, window.usedPercent));
}

function quotaProgressColorClass(usedPercent: number): string {
	if (usedPercent >= PROVIDER_QUOTA_DANGER_USED_PERCENT) return STATUS_PRESENTATION.error.fill;
	if (usedPercent >= PROVIDER_QUOTA_WARNING_USED_PERCENT) return STATUS_PRESENTATION.attention.fill;
	return STATUS_PRESENTATION.success.fill;
}

function quotaPercent(window: ProviderQuotaWindow, t: TFunction): string | null {
	if (window.unlimited) return t("usage.providerQuotaUnlimited");
	if (window.usedPercent === null) return null;
	const percent = Math.round(window.usedPercent * 10) / 10;
	return t("usage.providerQuotaUsedPercent", { percent });
}

function quotaCount(window: ProviderQuotaWindow, language: string, t: TFunction) {
	const unit =
		window.unit === "requests"
			? t("usage.providerQuotaRequests")
			: window.unit === "interactions"
				? t("usage.providerQuotaInteractions")
				: "";
	if (window.used !== null && window.limit !== null) {
		return t(unit ? "usage.providerQuotaCountUsedUnit" : "usage.providerQuotaCountUsed", {
			used: formatCount(window.used, language),
			limit: formatCount(window.limit, language),
			unit,
		});
	}
	if (window.remaining !== null && window.limit !== null) {
		return t(unit ? "usage.providerQuotaCountRemainingUnit" : "usage.providerQuotaCountRemaining", {
			remaining: formatCount(window.remaining, language),
			limit: formatCount(window.limit, language),
			unit,
		});
	}
	return null;
}

function formatAmount(amount: ProviderQuotaAmount, language: string, t: TFunction) {
	const format = (value: number) =>
		amount.unit === "credits"
			? t("usage.providerQuotaCreditsValue", { value: formatCount(value, language) })
			: new Intl.NumberFormat(language, { style: "currency", currency: amount.unit }).format(value);
	return amount.limit === null ? format(amount.value) : `${format(amount.value)} / ${format(amount.limit)}`;
}

function amountLabel(amount: ProviderQuotaAmount, t: TFunction): string {
	if (amount.kind === "balance") return t("usage.providerQuotaBalance");
	if (amount.kind === "remaining") return t("usage.providerQuotaAllowanceRemaining");
	if (amount.unit === "credits") return t("usage.providerQuotaCreditsUsed");
	switch (amount.period) {
		case "day":
			return t("usage.providerQuotaSpendDay");
		case "week":
			return t("usage.providerQuotaSpendWeek");
		case "month":
			return t("usage.providerQuotaSpendMonth");
		case "total":
			return t("usage.providerQuotaSpendTotal");
		default:
			return t("usage.providerQuotaSpend");
	}
}

function providerError(error: ProviderQuotaErrorCode | null, t: TFunction): string {
	switch (error) {
		case "authentication":
			return t("usage.providerQuotaErrorAuthentication");
		case "rate-limit":
			return t("usage.providerQuotaErrorRateLimit");
		case "timeout":
			return t("usage.providerQuotaErrorTimeout");
		case "network":
			return t("usage.providerQuotaErrorNetwork");
		case "invalid-response":
			return t("usage.providerQuotaErrorResponse");
		default:
			return t("usage.providerQuotaErrorService");
	}
}

function ProviderQuotaCard({ provider }: { provider: ProviderQuota }) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	return (
		<article className="rounded-panel border border-border-subtle bg-surface p-4 shadow-xs">
			<header className="flex min-w-0 items-center gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-hover">
					<ProviderGlyph provider={provider.id} size={20} />
				</span>
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-sm font-semibold text-text-primary">{provider.name}</h3>
					{provider.plan && <p className="truncate text-xs text-text-muted">{humanize(provider.plan)}</p>}
				</div>
				{provider.status === "error" && <Badge variant="danger">{t("usage.providerQuotaError")}</Badge>}
			</header>

			{provider.status === "error" ? (
				<p role="alert" className="mt-4 text-xs leading-relaxed text-danger">
					{providerError(provider.error, t)}
				</p>
			) : provider.windows.length === 0 && provider.amounts.length === 0 ? (
				<p className="mt-4 text-xs leading-relaxed text-text-muted">{t("usage.providerQuotaNoData")}</p>
			) : (
				<div className="mt-4 space-y-4">
					{provider.windows.map((window) => {
						const percent = quotaPercent(window, t);
						const count = quotaCount(window, language, t);
						const title = quotaWindowTitle(window, t);
						const progress = quotaUsedProgressPercent(window);
						return (
							<div key={window.id}>
								<div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
									<span className="truncate font-medium text-text-primary">{title}</span>
									{percent && <span className="shrink-0 tabular-nums text-text-muted">{percent}</span>}
								</div>
								{progress !== null && (
									<div
										role="progressbar"
										aria-label={title}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={progress}
										aria-valuetext={percent ?? undefined}
										className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-hover"
									>
										<div
											className={cn("h-full rounded-full", quotaProgressColorClass(progress))}
											style={{ width: `${progress}%` }}
										/>
									</div>
								)}
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
						<dl className="grid grid-cols-2 gap-2 border-t border-border-subtle pt-3">
							{provider.amounts.map((amount) => (
								<div
									key={`${amount.kind}-${amount.period ?? "none"}-${amount.unit}`}
									className="min-w-0 rounded-control bg-surface-raised px-2.5 py-2"
								>
									<dt className="truncate text-xs text-text-muted">{amountLabel(amount, t)}</dt>
									<dd className="mt-0.5 truncate text-xs font-medium tabular-nums text-text-primary">
										{formatAmount(amount, language, t)}
									</dd>
								</div>
							))}
						</dl>
					)}
				</div>
			)}
		</article>
	);
}

interface ProviderQuotaTickerItem {
	provider: ProviderQuota;
	window: ProviderQuotaWindow | null;
}

function providerQuotaTickerItems(
	snapshot: ProviderQuotaSnapshot | null,
	currentProviderId: string | null | undefined,
): ProviderQuotaTickerItem[] {
	if (!snapshot) return [];
	const providers =
		currentProviderId === undefined
			? snapshot.providers.filter((provider) => provider.status === "available")
			: snapshot.providers.filter((provider) => provider.id === currentProviderId && provider.status !== "unsupported");
	const items: ProviderQuotaTickerItem[] = [];
	for (const provider of providers) {
		const selected = preferredQuotaWindow(provider.windows);
		if (selected || currentProviderId !== undefined) items.push({ provider, window: selected });
	}
	return items;
}

function ProviderQuotaSummary({
	state,
	paused,
	currentProviderId,
}: {
	state: ProviderQuotaState;
	paused: boolean;
	currentProviderId: string | null | undefined;
}) {
	const { t, i18n } = useTranslation();
	const reducedMotion = useReducedMotion();
	const [index, setIndex] = useState(0);
	const items = providerQuotaTickerItems(state.snapshot, currentProviderId);
	const itemIds = items.map(({ provider, window }) => `${provider.id}:${window?.id ?? "summary"}`).join("|");

	useEffect(() => setIndex(0), [itemIds]);
	useEffect(() => {
		if (currentProviderId !== undefined || paused || reducedMotion || items.length < 2) return;
		const interval = window.setInterval(
			() => setIndex((current) => (current + 1) % items.length),
			PROVIDER_QUOTA_ROTATION_INTERVAL_MS,
		);
		return () => window.clearInterval(interval);
	}, [currentProviderId, items.length, paused, reducedMotion]);

	if (state.error && !state.snapshot)
		return <span className="truncate text-xs text-danger">{t("usage.providerQuotaUnavailable")}</span>;
	if (state.loading && !state.snapshot) return <span className="text-xs text-text-muted">…</span>;
	if (!state.snapshot || items.length === 0) {
		return <span className="truncate text-xs text-text-muted">{t("usage.providerQuotaNoQueryable")}</span>;
	}
	const item = items[index % items.length];
	if (!item) return null;
	const percent = item.window ? quotaPercent(item.window, t) : null;
	const progress = item.window ? quotaUsedProgressPercent(item.window) : null;
	const amount = item.provider.amounts[0];
	const summary =
		item.provider.status === "error"
			? t("usage.providerQuotaError")
			: (percent ?? (amount ? formatAmount(amount, i18n.resolvedLanguage ?? i18n.language, t) : null));
	return (
		<div className="relative h-8 min-w-0 flex-1 overflow-hidden">
			<AnimatePresence initial={false}>
				<motion.div
					key={`${item.provider.id}:${item.window?.id ?? "summary"}`}
					initial={reducedMotion ? false : { opacity: 0, y: 8 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: reducedMotion ? 0 : -8 }}
					transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
					className="absolute inset-0 flex min-w-0 flex-col justify-center"
				>
					<div className="flex min-w-0 items-center gap-1.5 text-xs">
						<ProviderGlyph provider={item.provider.id} size={13} className="shrink-0" />
						<span
							className="min-w-0 flex-1 truncate font-medium text-text-secondary"
							title={item.window ? `${item.provider.name} · ${quotaWindowTitle(item.window, t)}` : item.provider.name}
						>
							{item.provider.name}
							{item.window && <span className="ml-1 text-text-muted">· {quotaWindowTitle(item.window, t)}</span>}
						</span>
						{summary && (
							<span
								className={cn(
									"shrink-0 tabular-nums text-text-muted",
									item.provider.status === "error" && "text-danger",
								)}
							>
								{summary}
							</span>
						)}
					</div>
					{progress !== null && (
						<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-under" aria-hidden="true">
							<div
								className={cn("h-full rounded-full", quotaProgressColorClass(progress))}
								style={{ width: `${progress}%` }}
							/>
						</div>
					)}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}

interface TodayUsageState {
	totalTokens: number | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	skippedFileCount: number;
	loading: boolean;
	error: string | null;
}

const INITIAL_USAGE_STATE: TodayUsageState = {
	totalTokens: null,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	skippedFileCount: 0,
	loading: false,
	error: null,
};

export function TodayUsageSummary({
	refreshAt,
	currentProviderId,
}: {
	refreshAt: number;
	currentProviderId: string | null | undefined;
}) {
	const hostUsageApi = useDomainApi("usage");

	const { t, i18n } = useTranslation();
	const shown = useAtomValue(showTodayUsageAtom);
	const setAppMode = useSetAtom(appModeAtom);
	const setSettingsCategory = useSetAtom(settingsCategoryAtom);
	const [state, setState] = useState<TodayUsageState>(() =>
		shown ? { ...INITIAL_USAGE_STATE, loading: true } : INITIAL_USAGE_STATE,
	);
	const [quotaOpen, setQuotaOpen] = useState(false);
	const [quotaTickerPaused, setQuotaTickerPaused] = useState(false);

	const [quotaState, setQuotaState] = useState<ProviderQuotaState>(EMPTY_QUOTA_STATE);
	const statsRequestRevisionRef = useRef(0);
	const quotaRequestRef = useRef<Promise<void> | null>(null);
	const quotaLastAttemptAtRef = useRef(0);
	const quotaShownRef = useRef(shown);
	quotaShownRef.current = shown;
	const language = i18n.resolvedLanguage ?? i18n.language;

	const openSettings = (category: "models" | "usage") => {
		setQuotaOpen(false);
		setSettingsCategory(category);
		setAppMode("settings");
	};
	const loadProviderQuotas = useCallback(() => {
		if (quotaRequestRef.current) return quotaRequestRef.current;
		quotaLastAttemptAtRef.current = Date.now();
		setQuotaState((current) => ({ ...current, loading: true, error: false }));
		const request = hostUsageApi
			.getProviderQuotas()
			.then((snapshot) => {
				if (quotaShownRef.current) setQuotaState({ snapshot, loading: false, error: false });
			})
			.catch(() => {
				if (quotaShownRef.current) {
					setQuotaState((current) => ({ ...current, loading: false, error: true }));
				}
			})
			.finally(() => {
				quotaRequestRef.current = null;
			});
		quotaRequestRef.current = request;
		return request;
	}, [hostUsageApi]);

	useEffect(() => {
		void refreshAt;
		const revision = ++statsRequestRevisionRef.current;
		if (!shown) {
			setState(INITIAL_USAGE_STATE);
			return;
		}
		setState((current) => ({ ...current, loading: current.totalTokens === null, error: null }));
		void hostUsageApi
			.getStats(7)
			.then((snapshot) => {
				if (statsRequestRevisionRef.current !== revision) return;
				const today = snapshot.days.at(-1);
				if (!today) throw new Error("Usage statistics did not include today");
				setState({
					totalTokens: today.totalTokens,
					inputTokens: today.inputTokens,
					outputTokens: today.outputTokens,
					cacheReadTokens: today.cacheReadTokens,
					cacheWriteTokens: today.cacheWriteTokens,
					cost: today.cost,
					skippedFileCount: snapshot.skippedFileCount,
					loading: false,
					error: null,
				});
			})
			.catch((error: unknown) => {
				if (statsRequestRevisionRef.current !== revision) return;
				setState({ ...INITIAL_USAGE_STATE, error: errorMessage(error) });
			});
		return () => {
			if (statsRequestRevisionRef.current === revision) statsRequestRevisionRef.current += 1;
		};
	}, [hostUsageApi, refreshAt, shown]);

	useEffect(() => {
		if (!shown) {
			setQuotaState(EMPTY_QUOTA_STATE);
			setQuotaOpen(false);
			return;
		}
		quotaShownRef.current = true;
		void loadProviderQuotas();
		return () => {
			quotaShownRef.current = false;
		};
	}, [loadProviderQuotas, shown]);

	useEffect(() => {
		if (!shown) return;
		const refreshWhenDue = () => {
			if (
				document.visibilityState === "visible" &&
				Date.now() - quotaLastAttemptAtRef.current >= PROVIDER_QUOTA_REFRESH_INTERVAL_MS
			) {
				void loadProviderQuotas();
			}
		};
		const interval = window.setInterval(refreshWhenDue, PROVIDER_QUOTA_REFRESH_CHECK_INTERVAL_MS);
		document.addEventListener("visibilitychange", refreshWhenDue);
		return () => {
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", refreshWhenDue);
		};
	}, [loadProviderQuotas, shown]);

	if (!shown) return null;
	const value =
		state.totalTokens === null ? (
			state.loading ? (
				"…"
			) : (
				"—"
			)
		) : (
			<AnimatedNumber value={state.totalTokens} format={(amount) => formatCompactNumber(amount, language)} />
		);
	const detailValue = (amount: number) =>
		state.totalTokens === null ? (
			"—"
		) : (
			<AnimatedNumber value={amount} format={(current) => formatCompactNumber(current, language)} />
		);
	const costValue =
		state.totalTokens === null ? "—" : <AnimatedNumber value={state.cost} format={(amount) => formatCost(amount)} />;
	const parts = [
		{ label: t("session.usageInput"), value: state.inputTokens, color: "var(--color-chart-1)" },
		{ label: t("session.usageOutput"), value: state.outputTokens, color: "var(--color-chart-5)" },
		{ label: t("session.usageCacheRead"), value: state.cacheReadTokens, color: "var(--color-chart-2)" },
		{ label: t("session.usageCacheWrite"), value: state.cacheWriteTokens, color: "var(--color-chart-3)" },
	] as const;
	const componentTokens = parts.reduce((total, part) => total + part.value, 0);
	const mixTotal = Math.max(state.totalTokens ?? 0, componentTokens);
	const unattributedTokens = Math.max(0, mixTotal - componentTokens);
	const label = (() => {
		if (state.error) return t("usage.todayLoadFailed", { message: state.error });
		if (state.loading) return t("usage.todayLoading");
		if (state.skippedFileCount > 0) return t("usage.todayIncomplete", { count: state.skippedFileCount });
		if (unattributedTokens > 0) {
			return t("usage.todayBreakdownIncomplete", { amount: unattributedTokens.toLocaleString(language) });
		}
		return t("usage.todayTokensLabel", { amount: state.totalTokens?.toLocaleString(language) ?? "—" });
	})();
	const visibleQuotaProviders =
		quotaState.snapshot?.providers.filter((provider) => provider.status !== "unsupported") ?? [];

	return (
		<>
			<div className="scene-surface today-usage-summary mb-1 min-w-0 overflow-hidden rounded-control bg-today-usage">
				<button
					type="button"
					className="w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					aria-label={t("usage.openUsageSettings")}
					title={label}
					onClick={() => openSettings("usage")}
				>
					<div className="flex min-w-0 items-start gap-3">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
								<ChartColumn className="size-3.5 shrink-0" aria-hidden="true" />
								<span className="truncate">{t("usage.todayTokens")}</span>
								{state.error && <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />}
								{!state.error && (state.skippedFileCount > 0 || unattributedTokens > 0) && (
									<TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
								)}
							</div>
							<div className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-text-primary">{value}</div>
						</div>
						<div className="shrink-0 text-right">
							<div className="text-xs text-text-muted">{t("session.usageCost")}</div>
							<div className="mt-1 font-mono text-xs font-medium tabular-nums text-text-primary">{costValue}</div>
						</div>
					</div>
					<div className="mt-2 flex h-1 overflow-hidden rounded-full bg-surface-hover" aria-hidden="true">
						{mixTotal > 0 &&
							parts.map((part) => (
								<span
									key={part.label}
									style={{ width: `${(part.value / mixTotal) * 100}%`, backgroundColor: part.color }}
								/>
							))}
						{unattributedTokens > 0 && (
							<span
								style={{
									width: `${(unattributedTokens / mixTotal) * 100}%`,
									backgroundColor: "var(--color-chart-other)",
								}}
							/>
						)}
					</div>
					<dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
						{parts.map((part) => (
							<div key={part.label} className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
								<span
									className="size-1.5 shrink-0 rounded-full"
									style={{ backgroundColor: part.color }}
									aria-hidden="true"
								/>
								<dt className="min-w-0 flex-1 truncate text-text-muted">{part.label}</dt>
								<dd className="shrink-0 font-mono tabular-nums text-text-primary">{detailValue(part.value)}</dd>
							</div>
						))}
					</dl>
					<span className="sr-only" role={state.error ? "alert" : "status"}>
						{label}
					</span>
				</button>
				<button
					type="button"
					className="group flex min-h-11 w-full items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={() => setQuotaOpen(true)}
					onMouseEnter={() => setQuotaTickerPaused(true)}
					onMouseLeave={() => setQuotaTickerPaused(false)}
					onFocus={() => setQuotaTickerPaused(true)}
					onBlur={() => setQuotaTickerPaused(false)}
					aria-label={t("usage.providerQuotaTitle")}
					aria-haspopup="dialog"
					aria-expanded={quotaOpen}
				>
					<ProviderQuotaSummary
						state={quotaState}
						paused={quotaTickerPaused || quotaOpen}
						currentProviderId={currentProviderId}
					/>
					{quotaState.error && (
						<CircleAlert className="size-3.5 shrink-0 text-danger" aria-label={t("usage.providerQuotaRefreshFailed")} />
					)}
					<ChevronRight
						className="size-3.5 shrink-0 text-text-muted transition-colors group-hover:text-text-primary"
						aria-hidden="true"
					/>
				</button>
			</div>

			<Dialog open={quotaOpen} onOpenChange={setQuotaOpen}>
				<DialogContent size="large" className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col overflow-hidden p-0">
					<DialogHeader className="border-b border-border-subtle px-5 py-4 pr-14">
						<DialogTitle>{t("usage.providerQuotaDialogTitle")}</DialogTitle>
						<DialogDescription>{t("usage.providerQuotaDescription")}</DialogDescription>
					</DialogHeader>
					<DialogCloseButton aria-label={t("usage.providerQuotaClose")} />
					<div className="min-h-0 flex-1 overflow-y-auto p-5" aria-busy={quotaState.loading}>
						{quotaState.error && quotaState.snapshot && (
							<FeedbackNotice tone="danger" title={t("usage.providerQuotaRefreshFailed")} className="mb-4">
								{t("usage.providerQuotaRefreshFailedDescription")}
							</FeedbackNotice>
						)}
						{quotaState.snapshot ? (
							visibleQuotaProviders.length > 0 ? (
								<div className="grid gap-3 sm:grid-cols-2">
									{visibleQuotaProviders.map((provider) => (
										<ProviderQuotaCard key={provider.id} provider={provider} />
									))}
								</div>
							) : (
								<SettingsState
									compact
									icon={Gauge}
									title={t("usage.providerQuotaEmpty")}
									description={t("usage.providerQuotaEmptyDescription")}
									action={
										<Button size="sm" onClick={() => openSettings("models")}>
											{t("usage.providerQuotaConfigure")}
										</Button>
									}
								/>
							)
						) : quotaState.loading ? (
							<LoadingTransition className="min-h-52" label={t("usage.providerQuotaLoading")} />
						) : (
							<SettingsState
								compact
								icon={AlertCircle}
								tone="danger"
								title={t("usage.providerQuotaUnavailable")}
								description={t("usage.providerQuotaUnavailableDescription")}
								action={<SettingsRetryAction label={t("usage.retry")} onClick={() => void loadProviderQuotas()} />}
							/>
						)}
					</div>
					<footer className="flex min-h-12 items-center justify-between gap-3 border-t border-border-subtle px-5 py-2.5">
						<p className="truncate text-xs text-text-muted">
							{quotaState.snapshot
								? t("usage.providerQuotaUpdated", { time: formatUsageTime(quotaState.snapshot.generatedAt, language) })
								: t("usage.providerQuotaNotUpdated")}
						</p>
						<Button variant="outline" size="sm" disabled={quotaState.loading} onClick={() => void loadProviderQuotas()}>
							<RefreshCw
								className={cn("size-3.5", quotaState.loading && "animate-spin motion-reduce:animate-none")}
								aria-hidden="true"
							/>
							{t("usage.providerQuotaRefresh")}
						</Button>
					</footer>
				</DialogContent>
			</Dialog>
		</>
	);
}
