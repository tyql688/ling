import { ProviderQuotaDialog, type ProviderQuotaState } from "./provider-quota-dialog";
import {
	formatAmount,
	quotaPercent,
	quotaProgressColorClass,
	quotaUsedProgressPercent,
	quotaWindowTitle,
} from "./provider-quota-format";
import { formatCompactNumber } from "@renderer/lib/format-number";
import { preferredQuotaWindow } from "./quota-summary";
import { errorMessage } from "@ling/contracts/ling-error";
import type { ProviderQuota, ProviderQuotaSnapshot, ProviderQuotaWindow } from "@ling/contracts/usage";
import { AnimatedNumber } from "@renderer/components/ui/animated-number";
import { ProviderGlyph } from "@renderer/features/models/provider-glyph";
import { showTodayUsageAtom } from "@renderer/features/usage/preferences";
import { formatCost } from "@renderer/lib/format";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { appModeAtom, settingsCategoryAtom } from "@renderer/lib/navigation-state";
import { cn } from "@renderer/lib/utils";
import { useAtomValue, useSetAtom } from "jotai";
import { ChartColumn, ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const EMPTY_QUOTA_STATE: ProviderQuotaState = { snapshot: null, loading: false, error: false };
/** Session changes refresh immediately; external Pi activity is checked every five visible minutes.
 * This leaves the statistics worker's two-minute idle window free to release its scan cache. */
const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
/** Provider account data refreshes every five minutes while the app is visible. */
const PROVIDER_QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000;
/** A one-minute check keeps focus-triggered refreshes bounded without drifting far past the refresh interval. */
const PROVIDER_QUOTA_REFRESH_CHECK_INTERVAL_MS = 60_000;
/** Rotate account summaries every four seconds; hover, focus, an open dialog and reduced motion pause rotation. */
const PROVIDER_QUOTA_ROTATION_INTERVAL_MS = 4_000;
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
	const statsLastAttemptRef = useRef<{ at: number; refreshAt: number } | null>(null);
	const [statsRefreshTick, setStatsRefreshTick] = useState(0);
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
		void statsRefreshTick;
		const revision = ++statsRequestRevisionRef.current;
		if (!shown) {
			statsLastAttemptRef.current = null;
			setState(INITIAL_USAGE_STATE);
			return;
		}
		if (document.visibilityState !== "visible") return;
		statsLastAttemptRef.current = { at: Date.now(), refreshAt };
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
	}, [hostUsageApi, refreshAt, shown, statsRefreshTick]);

	useEffect(() => {
		if (!shown) return;
		const refreshWhenDue = () => {
			if (document.visibilityState !== "visible") return;
			const previous = statsLastAttemptRef.current;
			if (!previous || previous.refreshAt !== refreshAt || Date.now() - previous.at >= USAGE_REFRESH_INTERVAL_MS) {
				setStatsRefreshTick((tick) => tick + 1);
			}
		};
		// Focus can refresh between interval ticks; restart the interval from that attempt.
		const interval = window.setInterval(refreshWhenDue, USAGE_REFRESH_INTERVAL_MS);
		document.addEventListener("visibilitychange", refreshWhenDue);
		window.addEventListener("focus", refreshWhenDue);
		return () => {
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", refreshWhenDue);
			window.removeEventListener("focus", refreshWhenDue);
		};
	}, [refreshAt, shown, statsRefreshTick]);

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

	return (
		<>
			<div className="scene-surface today-usage-summary mb-1 min-w-0 overflow-hidden rounded-control bg-today-usage">
				<button
					type="button"
					className="w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
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
					className="group flex min-h-11 w-full items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
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

			<ProviderQuotaDialog
				open={quotaOpen}
				onOpenChange={setQuotaOpen}
				state={quotaState}
				onRefresh={loadProviderQuotas}
				onConfigure={() => openSettings("models")}
			/>
		</>
	);
}
