import type {
	DiagnosticLogLevel,
	DiagnosticLogQuery,
	DiagnosticLogRecord,
	DiagnosticProcess,
} from "@ling/contracts/diagnostics";
import { Button } from "@renderer/components/ui/button";
import { ChoiceButton } from "@renderer/components/ui/choice-button";
import { Input } from "@renderer/components/ui/input";
import { Segmented } from "@renderer/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { formatRequestError } from "@renderer/lib/errors";
import { formatAbsoluteTime, formatClockTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const REFRESH_INTERVAL_MS = 2_000;
const PAGE_SIZE = 200;
const RETAINED_LINES = PAGE_SIZE * 5;
const ALL_PROCESSES = "__all__";
type LevelFilter = "all" | "warn" | "error";
const LEVELS: Record<LevelFilter, DiagnosticLogLevel[] | undefined> = {
	all: undefined,
	warn: ["warn", "error"],
	error: ["error"],
};

const mebibytes = (bytes: number): string => `${Math.round(bytes / 1048576)} MiB`;

function uptime(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-xs text-text-muted">{label}</dt>
			<dd className="text-sm tabular-nums text-text-primary">{value}</dd>
		</div>
	);
}

function ProcessRow({ process, now }: { process: DiagnosticProcess; now: number }) {
	const { t } = useTranslation();
	const failed = process.state === "failed";
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
			<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className="text-sm font-medium text-text-primary">
					{t(process.role === "pi-control" ? "diagnostics.roleControl" : "diagnostics.roleSession")}
				</span>
				<span className={cn("text-xs", failed ? "font-medium text-danger" : "text-text-muted")}>
					{t(`diagnostics.state.${process.state}`)}
				</span>
				<span className="text-xs tabular-nums text-text-muted">
					pid {process.pid ?? "—"} · {t("diagnostics.generation", { count: process.generation })}
				</span>
			</div>
			{(process.sessionId || process.cwd) && (
				<p className="min-w-0 truncate text-xs text-text-muted" title={process.cwd}>
					{process.sessionId && (
						<span className="font-mono" title={process.sessionId}>
							{process.sessionId.slice(0, 8)}
						</span>
					)}
					{process.sessionId && process.cwd && " · "}
					{process.cwd}
				</p>
			)}
			<dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
				<Metric label={t("diagnostics.uptime")} value={uptime(process.startedAt, now)} />
				<Metric
					label={t("diagnostics.heap")}
					value={
						process.heapLimitBytes > 0
							? `${mebibytes(process.heapUsedBytes)} / ${mebibytes(process.heapLimitBytes)}`
							: "—"
					}
				/>
				<Metric label={t("diagnostics.loopDelay")} value={`${process.eventLoopDelayMs} ms`} />
				<Metric label={t("diagnostics.pendingRequests")} value={String(process.pendingRequests)} />
			</dl>
		</li>
	);
}

function LogLine({ record }: { record: DiagnosticLogRecord }) {
	const sessionId = record.correlation?.sessionId;
	return (
		<li className="flex flex-col gap-1 px-4 py-2 font-mono text-xs leading-relaxed sm:flex-row sm:gap-3 sm:px-5">
			<span className="flex shrink-0 gap-3 text-text-muted">
				<time
					dateTime={new Date(record.at).toISOString()}
					title={formatAbsoluteTime(record.at)}
					className="tabular-nums"
				>
					{formatClockTime(record.at)}
				</time>
				<span
					className={cn(
						"w-12 uppercase tracking-wide",
						record.level === "error"
							? "font-medium text-danger"
							: record.level === "warn"
								? "font-medium text-text-primary"
								: "",
					)}
				>
					{record.level}
				</span>
				<span className="whitespace-nowrap">
					{record.process}/{record.component}
				</span>
			</span>
			<span className="min-w-0 break-words text-text-primary">
				{record.message}
				{sessionId && (
					<span className="text-text-muted" title={sessionId}>
						{" "}
						· {sessionId.slice(0, 8)}
					</span>
				)}
			</span>
		</li>
	);
}

export function DiagnosticsView() {
	const { t } = useTranslation();
	const diagnostics = useDomainApi("diagnostics");
	const searchId = useId();
	const [processes, setProcesses] = useState<DiagnosticProcess[]>([]);
	const [now, setNow] = useState(() => Date.now());
	const [records, setRecords] = useState<DiagnosticLogRecord[]>([]);
	const [labels, setLabels] = useState<string[]>([]);
	const [level, setLevel] = useState<LevelFilter>("all");
	const [processFilter, setProcessFilter] = useState(ALL_PROCESSES);
	const [text, setText] = useState("");
	const [following, setFollowing] = useState(true);
	const [exhausted, setExhausted] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const latestRecordsRef = useRef(records);
	latestRecordsRef.current = records;
	/** Advances with every full load; a response from an earlier filter is dropped. */
	const generationRef = useRef(0);
	const loadingOlderRef = useRef(false);
	const filtered = level !== "all" || processFilter !== ALL_PROCESSES || text.trim() !== "";

	const filter = useCallback(
		(): DiagnosticLogQuery => ({
			limit: PAGE_SIZE,
			...(LEVELS[level] === undefined ? {} : { levels: LEVELS[level] }),
			...(processFilter === ALL_PROCESSES ? {} : { process: processFilter }),
			...(text.trim() === "" ? {} : { text: text.trim() }),
		}),
		[level, processFilter, text],
	);

	const load = useCallback(async () => {
		const generation = ++generationRef.current;
		try {
			const page = await diagnostics.logs(filter());
			if (generation !== generationRef.current) return;
			setRecords(page.records);
			setLabels(page.processes);
			setExhausted(page.records.length < PAGE_SIZE);
			setError(null);
		} catch (cause) {
			if (generation === generationRef.current) setError(formatRequestError(cause, t));
		}
	}, [diagnostics, filter, t]);

	const refreshProcesses = useCallback(async () => {
		try {
			setProcesses(await diagnostics.processes());
			setNow(Date.now());
		} catch (cause) {
			setError(formatRequestError(cause, t));
		}
	}, [diagnostics, t]);

	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		void refreshProcesses();
		const timer = setInterval(() => void refreshProcesses(), REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [refreshProcesses]);
	useEffect(() => {
		if (!following) return;
		let polling = false;
		const timer = setInterval(() => {
			// A slow poll must not overlap the next one, or both would prepend the same records.
			if (polling) return;
			polling = true;
			const generation = generationRef.current;
			const newest = latestRecordsRef.current[0]?.id;
			void diagnostics
				.logs({ ...filter(), ...(newest === undefined ? {} : { afterId: newest }) })
				.then((page) => {
					if (generation !== generationRef.current || page.records.length === 0) return;
					const fresh = newest === undefined ? page.records : [...page.records].reverse();
					setRecords((current) => [...fresh, ...current].slice(0, RETAINED_LINES));
				})
				.catch((cause: unknown) => {
					if (generation === generationRef.current) setError(formatRequestError(cause, t));
				})
				.finally(() => {
					polling = false;
				});
		}, REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [diagnostics, filter, following, t]);

	async function loadOlder() {
		const oldest = latestRecordsRef.current.at(-1)?.id;
		if (oldest === undefined || loadingOlderRef.current) return;
		const generation = generationRef.current;
		loadingOlderRef.current = true;
		try {
			const page = await diagnostics.logs({ ...filter(), beforeId: oldest });
			if (generation !== generationRef.current) return;
			setRecords((current) => [...current, ...page.records]);
			setExhausted(page.records.length < PAGE_SIZE);
		} catch (cause) {
			if (generation === generationRef.current) setError(formatRequestError(cause, t));
		} finally {
			loadingOlderRef.current = false;
		}
	}

	function clearFilters() {
		setLevel("all");
		setProcessFilter(ALL_PROCESSES);
		setText("");
	}

	function copyVisible() {
		const lines = records
			.slice()
			.reverse()
			.map(
				(record) =>
					`${new Date(record.at).toISOString()} ${record.level.padEnd(5)} [${record.process}/${record.component}] ${record.message}`,
			)
			.join("\n");
		void navigator.clipboard.writeText(lines).catch((cause: unknown) => setError(formatRequestError(cause, t)));
	}

	return (
		<SettingsPage title={t("diagnostics.title")} description={t("diagnostics.description")}>
			<SettingsSection title={t("diagnostics.processes")} description={t("diagnostics.processesDescription")}>
				{processes.length === 0 ? (
					<div className="px-4 py-3.5 sm:px-5">
						<p className="text-sm font-medium text-text-primary">{t("diagnostics.noProcesses")}</p>
						<p className="mt-0.5 text-xs text-text-muted">{t("diagnostics.noProcessesHint")}</p>
					</div>
				) : (
					<ul className="divide-y divide-border-subtle">
						{processes.map((process) => (
							<ProcessRow key={process.id} process={process} now={now} />
						))}
					</ul>
				)}
			</SettingsSection>
			<SettingsSection
				title={t("diagnostics.logs")}
				description={t("diagnostics.logsDescription")}
				action={
					<div className="flex flex-wrap items-center gap-2">
						<ChoiceButton selected={following} onClick={() => setFollowing((value) => !value)} className="min-h-8">
							{t("diagnostics.follow")}
						</ChoiceButton>
						<Button variant="outline" size="sm" onClick={copyVisible} disabled={records.length === 0}>
							{t("diagnostics.copyVisible")}
						</Button>
					</div>
				}
			>
				<div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
					<Segmented
						value={level}
						onChange={setLevel}
						ariaLabel={t("diagnostics.level")}
						options={[
							{ value: "all", label: t("diagnostics.levelAll") },
							{ value: "warn", label: t("diagnostics.levelWarn") },
							{ value: "error", label: t("diagnostics.levelError") },
						]}
					/>
					<Select value={processFilter} onValueChange={(value) => value && setProcessFilter(value)}>
						<SelectTrigger className="w-44" aria-label={t("diagnostics.process")}>
							<SelectValue>{processFilter === ALL_PROCESSES ? t("diagnostics.processAll") : processFilter}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL_PROCESSES}>{t("diagnostics.processAll")}</SelectItem>
							{labels.map((label) => (
								<SelectItem key={label} value={label}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<label htmlFor={searchId} className="sr-only">
						{t("diagnostics.search")}
					</label>
					<Input
						id={searchId}
						type="search"
						value={text}
						onChange={(event) => setText(event.target.value)}
						placeholder={t("diagnostics.searchPlaceholder")}
						className="min-w-48 flex-1"
					/>
				</div>
				{error && (
					<div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-danger sm:px-5">
						<span>{error}</span>
						<Button variant="outline" size="sm" onClick={() => void Promise.all([load(), refreshProcesses()])}>
							{t("session.retry")}
						</Button>
					</div>
				)}
				{records.length === 0 ? (
					<div className="px-4 py-3.5 sm:px-5">
						<p className="text-sm text-text-muted">{t(filtered ? "diagnostics.noMatches" : "diagnostics.noLogs")}</p>
						{filtered && (
							<Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
								{t("diagnostics.clearFilters")}
							</Button>
						)}
					</div>
				) : (
					<ul className="divide-y divide-border-subtle">
						{records.map((record) => (
							<LogLine key={record.id} record={record} />
						))}
					</ul>
				)}
				{!exhausted && records.length > 0 && (
					<div className="px-4 py-3 sm:px-5">
						<Button variant="outline" size="sm" onClick={() => void loadOlder()}>
							{t("diagnostics.loadOlder")}
						</Button>
					</div>
				)}
			</SettingsSection>
		</SettingsPage>
	);
}
