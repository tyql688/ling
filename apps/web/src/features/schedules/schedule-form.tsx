import { thinkingLevelSchema } from "@ling/contracts/companions";
import type { ThinkingLevel } from "@ling/contracts/session";
import type { OpenProjectInfo } from "@ling/contracts/project";
import type { ScheduleModel, ScheduleTask, ScheduleTaskInput } from "@ling/contracts/schedules";
import type { SessionSummary } from "@ling/contracts/session";
import { Button } from "@renderer/components/ui/button";
import { ChoiceButton } from "@renderer/components/ui/choice-button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { FormField } from "@renderer/components/ui/form-field";
import { Input } from "@renderer/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { Textarea } from "@renderer/components/ui/textarea";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

const thinkingLevels = thinkingLevelSchema.options;
const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function ChoiceSelect<T extends string>({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange(value: T): void;
	disabled?: boolean | undefined;
}) {
	return (
		<FormField label={label}>
			<Select
				value={value}
				{...(disabled === undefined ? {} : { disabled })}
				onValueChange={(next) => onChange(next as T)}
			>
				<SelectTrigger className="w-full">
					<SelectValue>{options.find((option) => option.value === value)?.label ?? value}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FormField>
	);
}

export function ScheduleForm({
	task: currentTask,
	projects,
	sessions,
	defaultCwd,
	save,
	busy,
	enabled,
	cancel,
}: {
	task: ScheduleTask | null;
	projects: OpenProjectInfo[];
	sessions: SessionSummary[];
	defaultCwd: string | null;
	save(input: ScheduleTaskInput): Promise<boolean>;
	busy: boolean;
	enabled: boolean;
	cancel(): void;
}) {
	const [task] = useState(currentTask);
	const { t } = useTranslation();
	const api = useDomainApi("schedules");
	const [title, setTitle] = useState(task?.title ?? "");
	const [prompt, setPrompt] = useState(task?.prompt ?? "");
	const [cwd, setCwd] = useState(task?.cwd ?? defaultCwd ?? projects[0]?.cwd ?? "");
	const [sessionId, setSession] = useState(task?.sessionId ?? "");
	const [kind, setKind] = useState<"once" | "interval" | "calendar">(task?.schedule.kind ?? "calendar");
	const [time, setTime] = useState(task?.schedule.kind === "calendar" ? task.schedule.time : "09:00");
	const [zone, setZone] = useState(
		task?.schedule.kind === "calendar" ? task.schedule.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone,
	);
	const invalidZone = useMemo(() => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: zone });
			return false;
		} catch {
			return true;
		}
	}, [zone]);
	const [days, setDays] = useState(task?.schedule.kind === "calendar" ? task.schedule.days : [0, 1, 2, 3, 4, 5, 6]);
	const [minutes, setMinutes] = useState(task?.schedule.kind === "interval" ? String(task.schedule.minutes) : "60");
	const [at, setAt] = useState(
		task?.schedule.kind === "once"
			? new Date(task.schedule.at - new Date(task.schedule.at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
			: "",
	);
	const [model, setModel] = useState(task?.model ? JSON.stringify([task.model.provider, task.model.id]) : "");
	const [models, setModels] = useState<ScheduleModel[]>([]);
	const [modelError, setModelError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		if (cwd) {
			setModelError(null);
			setModels([]);
			void api.models(cwd).then(
				(catalog) => {
					if (live) setModels(catalog);
				},
				(error: unknown) => {
					if (live) setModelError(formatRequestError(error));
				},
			);
		}
		return () => {
			live = false;
		};
	}, [api, cwd]);
	const [thinking, setThinking] = useState<ThinkingLevel | "">(task?.thinking ?? "");
	const [missed, setMissed] = useState(task?.missed ?? "skip");
	const [notifications, setNotifications] = useState(task?.notifications ?? "attention");
	const modelOptions = [
		{ value: "", label: t("schedules.followProjectModel") },
		...models.map((item) => ({
			value: JSON.stringify([item.provider, item.id]),
			label: `${item.name} · ${item.provider}`,
		})),
		...(model && !models.some((item) => JSON.stringify([item.provider, item.id]) === model)
			? [{ value: model, label: t("schedules.savedModelUnavailable") }]
			: []),
	];
	const valid =
		enabled &&
		!busy &&
		!!title.trim() &&
		!!prompt.trim() &&
		!!cwd &&
		(kind !== "once" || Number.isFinite(new Date(at).getTime())) &&
		(kind !== "interval" || (Number.isInteger(Number(minutes)) && Number(minutes) >= 5)) &&
		(kind !== "calendar" || (!!time && !invalidZone && days.length > 0));
	return (
		<form
			className="grid gap-4 sm:grid-cols-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (!valid) return;
				const chosen = model ? z.tuple([z.string(), z.string()]).parse(JSON.parse(model) as unknown) : null;
				void save({
					title,
					prompt,
					cwd,
					sessionId: sessionId || null,
					schedule:
						kind === "once"
							? { kind, at: new Date(at).getTime() }
							: kind === "interval"
								? { kind, minutes: Number(minutes), anchor: Date.now() }
								: { kind, time, timeZone: zone, days },
					model: chosen ? { provider: chosen[0], id: chosen[1] } : null,
					thinking: thinking || null,
					missed,
					notifications,
				});
			}}
		>
			<FormField label={t("schedules.name")} className="sm:col-span-2">
				<Input value={title} placeholder={t("schedules.namePlaceholder")} onChange={(e) => setTitle(e.target.value)} />
			</FormField>
			<FormField label={t("schedules.instructions")} className="sm:col-span-2">
				<Textarea
					value={prompt}
					rows={4}
					placeholder={t("schedules.instructionsPlaceholder")}
					onChange={(e) => setPrompt(e.target.value)}
				/>
			</FormField>
			<h3 className="text-xs font-medium uppercase tracking-wide text-text-muted sm:col-span-2">
				{t("schedules.details")}
			</h3>
			<ChoiceSelect
				label={t("schedules.project")}
				value={cwd}
				options={projects.map((project) => ({ value: project.cwd, label: project.name }))}
				onChange={(value) => {
					setCwd(value);
					setSession("");
					setModel("");
					setThinking("");
				}}
			/>
			<ChoiceSelect
				label={t("schedules.runIn")}
				value={sessionId}
				options={[
					{ value: "", label: t("schedules.newConversation") },
					...sessions
						.filter((session) => session.cwd === cwd)
						.map((session) => ({ value: session.id, label: session.title })),
				]}
				onChange={setSession}
			/>
			<h3 className="text-xs font-medium uppercase tracking-wide text-text-muted sm:col-span-2">
				{t("schedules.frequency")}
			</h3>
			<ChoiceSelect<"once" | "interval" | "calendar">
				label={t("schedules.repeat")}
				value={kind}
				options={[
					{ value: "once", label: t("schedules.once") },
					{ value: "interval", label: t("schedules.everyNMinutes") },
					{ value: "calendar", label: t("schedules.dailyWeekly") },
				]}
				onChange={setKind}
			/>
			{kind === "once" && (
				<FormField label={t("schedules.whenLocal")}>
					<Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
				</FormField>
			)}
			{kind === "interval" && (
				<FormField label={t("schedules.intervalMinutes")}>
					<Input type="number" min={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
				</FormField>
			)}
			{kind === "calendar" && (
				<>
					<div className="flex gap-3 sm:col-span-2">
						<FormField label={t("schedules.time")} className="w-32">
							<Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
						</FormField>
						<FormField
							label={t("schedules.timeZone")}
							className="min-w-0 flex-1"
							{...(invalidZone ? { description: t("schedules.timeZoneHint") } : {})}
						>
							<Input value={zone} aria-invalid={invalidZone} onChange={(e) => setZone(e.target.value)} />
						</FormField>
					</div>
					<div className="flex flex-wrap gap-2 sm:col-span-2" role="group" aria-label={t("schedules.days")}>
						{dayKeys.map((day, index) => (
							<ChoiceButton
								key={day}
								selected={days.includes(index)}
								onClick={() => setDays(days.includes(index) ? days.filter((d) => d !== index) : [...days, index])}
							>
								{t(`schedules.day.${day}`)}
							</ChoiceButton>
						))}
					</div>
				</>
			)}
			<details className="sm:col-span-2">
				<summary className="cursor-default text-sm text-text-muted">{t("schedules.moreOptions")}</summary>
				<div className="mt-3 grid gap-4 sm:grid-cols-2">
					<ChoiceSelect label={t("schedules.model")} value={model} options={modelOptions} onChange={setModel} />
					{modelError && (
						<FeedbackNotice tone="danger" className="text-xs sm:col-span-2">
							{modelError}
						</FeedbackNotice>
					)}
					<ChoiceSelect<ThinkingLevel | "">
						label={t("schedules.reasoning")}
						value={thinking}
						options={[
							{ value: "", label: t("schedules.followSettings") },
							...thinkingLevels.map((value) => ({ value, label: t(`schedules.thinking.${value}`) })),
						]}
						onChange={setThinking}
					/>
					<ChoiceSelect<"skip" | "latest">
						label={t("schedules.missedRuns")}
						value={missed}
						options={[
							{ value: "skip", label: t("schedules.missed.skip") },
							{ value: "latest", label: t("schedules.missed.latest") },
						]}
						onChange={setMissed}
					/>
					<ChoiceSelect<"all" | "attention" | "none">
						label={t("schedules.notifications")}
						value={notifications}
						options={[
							{ value: "all", label: t("schedules.notify.all") },
							{ value: "attention", label: t("schedules.notify.attention") },
							{ value: "none", label: t("schedules.notify.none") },
						]}
						onChange={setNotifications}
					/>
				</div>
			</details>
			<div className="flex justify-end gap-2 sm:col-span-2">
				<Button type="button" variant="ghost" disabled={busy} onClick={cancel}>
					{t("schedules.cancel")}
				</Button>
				<Button type="submit" disabled={!valid}>
					{busy ? t("schedules.saving") : t("schedules.save")}
				</Button>
			</div>
		</form>
	);
}
