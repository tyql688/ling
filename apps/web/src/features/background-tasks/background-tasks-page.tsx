import { activeJobStatuses } from "@ling/contracts/background-tasks";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { FormField } from "@renderer/components/ui/form-field";
import { Input } from "@renderer/components/ui/input";
import { PanelPage } from "@renderer/components/ui/panel-page";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBackgroundTasks } from "./use-background-tasks";
import { BuiltinFeatureNotice } from "@renderer/features/companions/builtin-features";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";

// Keep the renderer tail smaller than the Host's retained log without hiding that it was shortened.
const OUTPUT_TEXT_LIMIT = 200_000;

function Output({ sessionRef, id }: { sessionRef: SessionRef; id: string }) {
	const { t } = useTranslation();
	const api = useDomainApi("backgroundTasks");
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		let offset = 0;
		let accumulated = "";
		let truncated = false;
		setText("");
		setError(null);
		async function read() {
			try {
				const result = await api.read({ ref: sessionRef, id, offset });
				if (stopped) return;
				offset = result.offset;
				const combined = accumulated + result.text;
				truncated ||= result.truncated || combined.length > OUTPUT_TEXT_LIMIT;
				accumulated = combined.slice(-OUTPUT_TEXT_LIMIT);
				setText((truncated ? `${t("backgroundTasks.truncated")}\n` : "") + accumulated);
				if (activeJobStatuses.has(result.process.status) || result.text) timer = setTimeout(() => void read(), 300);
			} catch (failure) {
				if (!stopped) setError(formatRequestError(failure));
			}
		}
		void read();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
		// The session key, not the ref object identity, scopes this reader.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [api, id, sessionKey(sessionRef), t]);
	return (
		<>
			{error && (
				<FeedbackNotice tone="danger" className="text-xs">
					{error}
				</FeedbackNotice>
			)}
			<pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-control bg-surface p-4 text-xs [overflow-wrap:anywhere]">
				{text || t("backgroundTasks.waiting")}
			</pre>
		</>
	);
}

export function BackgroundTasksPage({ sessionRef }: { sessionRef: SessionRef }) {
	const { t } = useTranslation();
	const api = useDomainApi("backgroundTasks");
	const state = useBackgroundTasks(sessionRef);
	const enabled = useBuiltinFeatures().value?.enabled["background-tasks"] === true;
	const [command, setCommand] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	return (
		<PanelPage title={t("backgroundTasks.title")}>
			<BuiltinFeatureNotice id="background-tasks" />
			{state.error && <FeedbackNotice tone="danger">{state.error}</FeedbackNotice>}
			<form
				className="flex flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!enabled || state.busy || !command.trim()) return;
					void state.act(
						() => api.start({ ref: sessionRef, command }),
						() => setCommand(""),
					);
				}}
			>
				<FormField label={t("backgroundTasks.command")} className="min-w-0 flex-1">
					<Input
						disabled={!enabled}
						value={command}
						placeholder={t("backgroundTasks.commandPlaceholder")}
						onChange={(event) => setCommand(event.target.value)}
					/>
				</FormField>
				<Button type="submit" disabled={!enabled || state.busy || !command.trim()}>
					{t("backgroundTasks.run")}
				</Button>
			</form>
			{state.value?.length === 0 && <p className="text-xs text-text-muted">{t("backgroundTasks.empty")}</p>}
			{state.value?.map((job) => (
				<div key={job.id} className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle py-3">
						<Button
							variant="outline"
							size="sm"
							className="min-w-0 flex-1 justify-start text-left font-mono [overflow-wrap:anywhere]"
							aria-expanded={selected === job.id}
							onClick={() => setSelected(selected === job.id ? null : job.id)}
						>
							<span className="truncate">{job.command}</span>
						</Button>
						<span className="text-xs text-text-muted">
							{t(`backgroundTasks.status.${job.status}`)}
							{job.exitCode !== null ? ` · ${job.exitCode}` : ""}
						</span>
						{activeJobStatuses.has(job.status) && (
							<Button
								variant="outline"
								size="sm"
								disabled={state.busy || job.status === "stopping"}
								onClick={() => void state.act(() => api.stop({ ref: sessionRef, id: job.id }))}
							>
								{t("backgroundTasks.stop")}
							</Button>
						)}
					</div>
					{job.error && (
						<FeedbackNotice tone="danger" className="text-xs">
							{job.error}
						</FeedbackNotice>
					)}
					{selected === job.id && <Output sessionRef={sessionRef} id={job.id} />}
				</div>
			))}
		</PanelPage>
	);
}
