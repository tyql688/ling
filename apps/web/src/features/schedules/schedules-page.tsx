import type { ScheduleTaskInput } from "@ling/contracts/schedules";
import { Button } from "@renderer/components/ui/button";
import { EmptyState } from "@renderer/components/ui/empty-state";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { Segmented } from "@renderer/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { openProjectsAtom } from "@renderer/features/projects/state";
import { activeSessionRefAtom, sessionsAtom } from "@renderer/features/sessions/state/session";
import { useAppNavigation } from "@renderer/lib/app-navigation";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { cn } from "@renderer/lib/utils";
import { useAtomValue } from "jotai";
import {
	Calendar,
	Check,
	ChevronRight,
	Clock,
	ListTodo,
	MessageSquare,
	Pause,
	Pencil,
	Play,
	Plus,
	Search,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScheduleForm } from "./schedule-form";
import { dateLabel, scheduleLabel } from "./schedule-labels";
import { useSchedules } from "./use-schedules";
import { BuiltinFeatureNotice } from "@renderer/features/companions/builtin-features";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";

const filters = ["all", "active", "paused", "completed"] as const;
type Filter = (typeof filters)[number];
const runningStatuses = new Set(["prepared", "running"]);

export function SchedulesPage() {
	const { t, i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? i18n.language;
	const api = useDomainApi("schedules");
	const navigation = useAppNavigation();
	const state = useSchedules();
	const enabled = useBuiltinFeatures().value?.enabled.schedules === true;
	const projects = useAtomValue(openProjectsAtom).filter((item) => item.availability !== "missing");
	const sessions = useAtomValue(sessionsAtom);
	const activeSessionRef = useAtomValue(activeSessionRefAtom);
	const [selected, setSelected] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [chatError, setChatError] = useState<string | null>(null);
	const [project, setProject] = useState(activeSessionRef?.cwd ?? "");
	const page = useRef<HTMLDivElement>(null);
	const cwd = projects.some((item) => item.cwd === project) ? project : projects[0]?.cwd;
	const tasks = state.value?.tasks ?? [];
	const task = tasks.find((item) => item.id === selected) ?? null;
	const allHistory = state.value?.history ?? [];
	const history = task
		? allHistory
				.filter((entry) => entry.taskId === task.id)
				.slice()
				.reverse()
		: [];
	const running = history.some((entry) => runningStatuses.has(entry.status));
	const visible = tasks.filter(
		(item) =>
			(filter === "all" || item.status === filter) &&
			`${item.title} ${item.prompt}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
	);
	const detail = editing || task !== null;
	const error = chatError ?? state.error ?? state.value?.error ?? null;
	const scrollToTop = () => page.current?.scrollTo({ top: 0 });
	function compose(text: string) {
		if (!enabled || !cwd) return;
		setChatError(null);
		try {
			navigation.compose(cwd, text);
		} catch (cause) {
			setChatError(formatRequestError(cause));
		}
	}
	function closeDetail() {
		scrollToTop();
		setSelected(null);
		setEditing(false);
		setConfirmDelete(false);
	}
	function selectTask(id: string) {
		scrollToTop();
		setSelected(id);
		setEditing(false);
		setConfirmDelete(false);
	}
	const statusIcon = (status: string, active: boolean) =>
		active ? Play : status === "paused" ? Pause : status === "completed" ? Check : Clock;
	return (
		<div ref={page} className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-10 pt-4 sm:px-8">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex flex-col gap-1">
						<h1 className="text-xl font-semibold tracking-[-0.025em] text-text-primary">{t("schedules.title")}</h1>
						<p className="text-sm text-text-muted">{t("schedules.tagline")}</p>
					</div>
					{!editing && (
						<div className="flex flex-wrap gap-2">
							<Button disabled={!enabled || !cwd} onClick={() => compose(t("schedules.composePrompt"))}>
								<MessageSquare className="size-4" aria-hidden="true" />
								{t("schedules.createWithConversation")}
							</Button>
							<Button
								variant="ghost"
								disabled={!enabled || !cwd}
								onClick={() => {
									scrollToTop();
									setSelected(null);
									setEditing(true);
								}}
							>
								<Plus className="size-4" aria-hidden="true" />
								{t("schedules.setUpManually")}
							</Button>
						</div>
					)}
				</header>
				<BuiltinFeatureNotice id="schedules" />
				{error && <FeedbackNotice tone="danger">{error}</FeedbackNotice>}
				{!state.value && !error ? (
					<p role="status" className="text-sm text-text-muted">
						{t("schedules.loading")}
					</p>
				) : (
					<div className={cn("grid gap-6", detail && "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
						<section className={cn("flex min-w-0 flex-col gap-3", editing && "hidden lg:flex")}>
							<div className="flex items-center gap-2 rounded-control border border-border-subtle bg-input px-2.5">
								<Search className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
								<Input
									aria-label={t("schedules.search")}
									placeholder={t("schedules.search")}
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									className="h-9 border-0 bg-transparent px-0"
								/>
							</div>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<Segmented
									ariaLabel={t("schedules.filter")}
									value={filter}
									options={filters.map((value) => ({ value, label: t(`schedules.filters.${value}`) }))}
									onChange={setFilter}
								/>
								{allHistory.some((entry) => entry.unread) && (
									<TooltipIconButton
										label={t("schedules.markAllRead")}
										disabled={state.busy}
										onClick={() => void state.act(() => api.markRead(null))}
									>
										<Check className="size-4" aria-hidden="true" />
									</TooltipIconButton>
								)}
							</div>
							{visible.length > 0 ? (
								<ul className="flex flex-col gap-1">
									{visible.map((item) => {
										const latest = allHistory.findLast((entry) => entry.taskId === item.id);
										const active = !!latest && runningStatuses.has(latest.status);
										const unread = allHistory.some((entry) => entry.taskId === item.id && entry.unread);
										const Icon = statusIcon(item.status, active);
										return (
											<li key={item.id}>
												<button
													type="button"
													aria-pressed={item.id === selected}
													disabled={editing}
													onClick={() => selectTask(item.id)}
													className={cn(
														"flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-50",
														item.id === selected && "bg-surface-hover",
													)}
												>
													<Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
													<span className="flex min-w-0 flex-1 flex-col gap-0.5">
														<span className="truncate text-sm font-medium">{item.title}</span>
														<span className="truncate text-xs text-text-muted">
															{scheduleLabel(item.schedule, t, locale)}
														</span>
														<span className="text-xs text-text-muted">
															{active
																? t("schedules.status.running")
																: !enabled && item.status === "active"
																	? t("builtinFeatures.schedulesPaused")
																	: item.status === "active" && item.nextAt !== null
																		? `${t("schedules.nextRun")} ${dateLabel(item.nextAt, locale)}`
																		: t(`schedules.status.${item.status}`)}
														</span>
													</span>
													{unread ? (
														<span
															role="img"
															aria-label={t("schedules.unreadResults")}
															className="size-2 shrink-0 rounded-full bg-accent"
														/>
													) : (
														<ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
													)}
												</button>
											</li>
										);
									})}
								</ul>
							) : (
								<EmptyState
									icon={Clock}
									title={t(tasks.length === 0 ? "schedules.emptyTitle" : "schedules.noMatches")}
									description={t(tasks.length === 0 ? "schedules.emptyDescription" : "schedules.noMatchesHint")}
								/>
							)}
							{!detail && tasks.length === 0 && (
								<div className="flex flex-col gap-2 rounded-panel border border-border-subtle p-4">
									<div className="flex flex-wrap items-center justify-between gap-2">
										<h2 className="text-sm font-semibold">{t("schedules.ideas")}</h2>
										<Select value={cwd ?? ""} onValueChange={setProject}>
											<SelectTrigger size="sm" aria-label={t("schedules.ideaProject")}>
												<SelectValue>{projects.find((item) => item.cwd === cwd)?.name ?? ""}</SelectValue>
											</SelectTrigger>
											<SelectContent>
												{projects.map((item) => (
													<SelectItem key={item.cwd} value={item.cwd}>
														{item.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									{(
										[
											["briefing", Calendar],
											["weeklyReview", ListTodo],
										] as const
									).map(([idea, Icon]) => (
										<button
											key={idea}
											type="button"
											disabled={!enabled || !cwd}
											onClick={() => compose(t(`schedules.idea.${idea}.prompt`))}
											className="flex items-center gap-3 rounded-control px-3 py-2 text-left hover:bg-surface-hover disabled:opacity-50"
										>
											<Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="text-sm">{t(`schedules.idea.${idea}.title`)}</span>
												<span className="text-xs text-text-muted">{t("schedules.customizeInConversation")}</span>
											</span>
											<ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
										</button>
									))}
								</div>
							)}
							{!detail && <p className="text-xs text-text-muted">{t("schedules.footnote")}</p>}
						</section>
						{detail && (
							<section aria-label={task?.title ?? t("schedules.newTask")} className="flex min-w-0 flex-col gap-4">
								<div className="flex items-start justify-between gap-3">
									<div className="flex min-w-0 flex-col gap-0.5">
										<span className="text-xs text-text-muted">
											{editing
												? t(task ? "schedules.editTask" : "schedules.newTask")
												: t(`schedules.status.${task!.status}`)}
										</span>
										<h2 className="text-lg font-semibold [overflow-wrap:anywhere]">
											{task?.title ?? t("schedules.setUpTask")}
										</h2>
									</div>
									{!editing && (
										<TooltipIconButton label={t("schedules.backToTasks")} onClick={closeDetail}>
											<X className="size-4" aria-hidden="true" />
										</TooltipIconButton>
									)}
								</div>
								{editing ? (
									<ScheduleForm
										key={task?.id ?? "new"}
										task={task}
										projects={projects}
										sessions={sessions}
										defaultCwd={activeSessionRef?.cwd ?? null}
										busy={state.busy}
										enabled={enabled}
										cancel={() => {
											scrollToTop();
											setEditing(false);
										}}
										save={async (input: ScheduleTaskInput) => {
											if (!enabled) return false;
											let savedId: string | null = null;
											const ok = await state.act(
												() => api.save({ id: task?.id ?? null, expectedRevision: task?.revision ?? null, task: input }),
												(result) => {
													savedId = task?.id ?? result.tasks.at(-1)?.id ?? null;
												},
											);
											if (ok) {
												scrollToTop();
												setEditing(false);
												setSelected(savedId);
											}
											return ok;
										}}
									/>
								) : (
									task && (
										<>
											<div className="flex flex-wrap gap-2">
												<Button
													variant="outline"
													size="sm"
													disabled={state.busy || (!enabled && task.status !== "active")}
													onClick={() =>
														void state.act(() =>
															api.setStatus({
																id: task.id,
																revision: task.revision,
																status: task.status === "active" ? "paused" : "active",
															}),
														)
													}
												>
													{task.status === "active" ? (
														<Pause className="size-3.5" aria-hidden="true" />
													) : (
														<Play className="size-3.5" aria-hidden="true" />
													)}
													{t(task.status === "active" ? "schedules.pause" : "schedules.enable")}
												</Button>
												<Button
													variant="ghost"
													size="sm"
													disabled={!enabled}
													onClick={() => {
														scrollToTop();
														setEditing(true);
													}}
												>
													<Pencil className="size-3.5" aria-hidden="true" />
													{t("schedules.edit")}
												</Button>
												<Button
													variant="ghost"
													size="sm"
													disabled={state.busy || (!enabled && !running)}
													onClick={() =>
														void state.act(async () => {
															if (running) await api.stop({ id: task.id });
															else await api.run({ id: task.id });
														})
													}
												>
													{running ? (
														<Square className="size-3.5" aria-hidden="true" />
													) : (
														<Play className="size-3.5" aria-hidden="true" />
													)}
													{t(running ? "schedules.stopRun" : "schedules.runNow")}
												</Button>
											</div>
											<p className="whitespace-pre-wrap rounded-control bg-surface p-3 text-sm [overflow-wrap:anywhere]">
												{task.prompt}
											</p>
											<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
												{[
													[t("schedules.project"), projects.find((item) => item.cwd === task.cwd)?.name ?? task.cwd],
													[
														t("schedules.runIn"),
														task.sessionId ? t("schedules.thisConversation") : t("schedules.newConversation"),
													],
													[
														t("schedules.model"),
														task.model
															? `${task.model.provider} / ${task.model.id}`
															: t("schedules.followProjectModel"),
													],
													[
														t("schedules.reasoning"),
														task.thinking ? t(`schedules.thinking.${task.thinking}`) : t("schedules.followSettings"),
													],
													[t("schedules.repeat"), scheduleLabel(task.schedule, t, locale)],
													...(task.schedule.kind === "calendar"
														? [[t("schedules.timeZone"), task.schedule.timeZone]]
														: []),
													[
														t("schedules.nextRun"),
														task.status === "active" && task.nextAt !== null
															? dateLabel(task.nextAt, locale)
															: t(`schedules.status.${task.status}`),
													],
													[t("schedules.missedRuns"), t(`schedules.missed.${task.missed}`)],
													[t("schedules.notifications"), t(`schedules.notify.${task.notifications}`)],
												].map(([label, value]) => (
													<div key={label} className="contents">
														<dt className="text-text-muted">{label}</dt>
														<dd className="truncate" title={value}>
															{value}
														</dd>
													</div>
												))}
											</dl>
											<h3 className="text-sm font-semibold">
												{t("schedules.runHistory")}{" "}
												<span className="text-xs font-normal text-text-muted">{history.length}</span>
											</h3>
											{history.length === 0 ? (
												<p className="text-xs text-text-muted">{t("schedules.noRuns")}</p>
											) : (
												<ul className="flex flex-col gap-2">
													{history.map((entry) => {
														const Icon =
															entry.status === "completed" ? Check : runningStatuses.has(entry.status) ? Play : Clock;
														return (
															<li key={entry.id} className="flex flex-col gap-1">
																<button
																	type="button"
																	disabled={!entry.sessionId}
																	onClick={() => {
																		void navigation
																			.openSession({ cwd: entry.cwd, sessionId: entry.sessionId! })
																			.catch((cause: unknown) => setChatError(formatRequestError(cause)));
																		void state.act(() => api.markRead(entry.id));
																	}}
																	className="flex items-center gap-3 rounded-control px-2 py-1.5 text-left hover:bg-surface-hover disabled:opacity-60"
																>
																	<Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
																	<span className="flex min-w-0 flex-1 flex-col">
																		<span className="text-sm">{t(`schedules.status.${entry.status}`)}</span>
																		<span className="text-xs text-text-muted">
																			{dateLabel(entry.startedAt, locale)}
																		</span>
																	</span>
																	{entry.unread && (
																		<span
																			role="img"
																			aria-label={t("schedules.unreadResult")}
																			className="size-2 shrink-0 rounded-full bg-accent"
																		/>
																	)}
																	<ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
																</button>
																{entry.summary && (
																	<p className="px-2 text-xs text-text-muted [overflow-wrap:anywhere]">
																		{entry.summary}
																	</p>
																)}
																{entry.error && (
																	<FeedbackNotice tone="danger" className="text-xs">
																		{entry.error}
																	</FeedbackNotice>
																)}
															</li>
														);
													})}
												</ul>
											)}
											<div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
												{confirmDelete && <p className="text-sm">{t("schedules.deleteConfirm")}</p>}
												<div className="flex gap-2">
													<Button
														variant="ghost"
														size="sm"
														disabled={state.busy || running}
														onClick={() => {
															if (!confirmDelete) {
																setConfirmDelete(true);
																return;
															}
															void state
																.act(() => api.delete({ id: task.id, revision: task.revision }))
																.then((ok) => ok && closeDetail());
														}}
													>
														<Trash2 className="size-3.5" aria-hidden="true" />
														{t(confirmDelete ? "schedules.confirmDeletion" : "schedules.deleteTask")}
													</Button>
													{confirmDelete && (
														<Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
															{t("schedules.cancel")}
														</Button>
													)}
												</div>
											</div>
										</>
									)
								)}
							</section>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
