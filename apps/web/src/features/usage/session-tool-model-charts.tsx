import { formatCompactNumber } from "@renderer/lib/format-number";
import { usageModelKey } from "@ling/contracts/usage";
import { formatShare } from "@renderer/features/usage/usage-format";
import type { LucideIcon } from "lucide-react";
import { Ellipsis, FilePenLine, FilePlus2, FileText, ListTodo, Search, Terminal, Wrench } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { chartColor, MAX_MODEL_SERIES } from "./usage-view-model";
import type { SessionModelUsage, SessionToolUsage } from "./workspace-session-usage";

const MAX_VISIBLE_TOOLS = 7;

const BUILTIN_TOOL_LABELS: Readonly<Record<string, string>> = {
	bash: "Bash",
	edit: "Edit",
	find: "Find",
	grep: "Search",
	read: "Read",
	todo: "Tasks",
	write: "Write",
};

function toolIcon(name: string): LucideIcon {
	const normalized = name.toLowerCase();
	if (normalized.includes("bash") || normalized.includes("terminal")) return Terminal;
	if (normalized.includes("read")) return FileText;
	if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("find")) return Search;
	if (normalized.includes("edit") || normalized.includes("replace")) return FilePenLine;
	if (normalized.includes("write")) return FilePlus2;
	if (normalized.includes("todo") || normalized.includes("plan")) return ListTodo;
	return Wrench;
}

function toolLabel(name: string): string {
	return BUILTIN_TOOL_LABELS[name.toLowerCase()] ?? name;
}

function toolColor(name: string): string {
	const normalized = name.toLowerCase();
	if (normalized.includes("bash") || normalized.includes("terminal")) return "var(--color-tool-terminal)";
	if (normalized.includes("read")) return "var(--color-tool-read)";
	if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("find")) {
		return "var(--color-tool-search)";
	}
	if (normalized.includes("edit") || normalized.includes("replace")) return "var(--color-tool-edit)";
	if (normalized.includes("write")) return "var(--color-tool-write)";
	if (normalized.includes("todo") || normalized.includes("plan")) return "var(--color-tool-plan)";
	return "var(--color-tool-other)";
}

export function SessionModelBreakdown({
	models,
	totalTokens,
}: {
	models: readonly SessionModelUsage[];
	totalTokens: number;
}) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	if (models.length === 0) {
		return <p className="py-5 text-center text-sm text-text-muted">{t("session.usageNoModels")}</p>;
	}
	const attributedTokens = models.reduce((total, model) => total + model.totalTokens, 0);
	const shareTotal = Math.max(totalTokens, attributedTokens);

	return (
		<ul className="list-none space-y-3">
			{models.map((model, index) => {
				const identity = model.provider ? `${model.provider}/${model.model}` : model.model;
				const share = shareTotal > 0 ? model.totalTokens / shareTotal : 0;
				const color = chartColor(index % MAX_MODEL_SERIES);
				return (
					<li key={usageModelKey(model.provider, model.model)}>
						<div className="flex min-w-0 items-start justify-between gap-4">
							<div className="min-w-0">
								<div className="truncate font-mono text-xs font-medium text-text-primary" title={identity}>
									{model.model}
								</div>
								<div className="mt-0.5 truncate text-xs text-text-muted">
									{model.provider ? `${model.provider} · ` : ""}
									{t("session.usageModelResponses", { count: model.responses })}
								</div>
							</div>
							<div className="shrink-0 text-right font-mono text-xs tabular-nums text-text-primary">
								{formatCompactNumber(model.totalTokens, language)}
								<span className="ml-1.5 text-xs text-text-muted">{formatShare(share)}</span>
							</div>
						</div>
						<div className="mt-2 h-1 overflow-hidden rounded-full bg-surface" aria-hidden="true">
							<div
								className="session-usage-tool-fill h-full rounded-full"
								style={{ width: `${share * 100}%`, backgroundColor: color }}
							/>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

export function SessionToolBreakdown({ tools }: { tools: readonly SessionToolUsage[] }) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	if (tools.length === 0) {
		return <p className="py-8 text-center text-sm text-text-muted">{t("session.usageNoTools")}</p>;
	}
	const totalCalls = tools.reduce((total, tool) => total + tool.calls, 0);
	const visible = tools.slice(0, MAX_VISIBLE_TOOLS);
	const hidden = tools.slice(MAX_VISIBLE_TOOLS);
	const hiddenCalls = hidden.reduce((total, tool) => total + tool.calls, 0);
	const rows: SessionToolUsage[] =
		hiddenCalls > 0
			? [
					...visible,
					{
						name: t("session.usageOtherTools"),
						calls: hiddenCalls,
						failures: hidden.reduce((total, tool) => total + tool.failures, 0),
					},
				]
			: visible;

	return (
		<ul className="session-usage-tool-list list-none">
			{rows.map((tool, index) => {
				const other = hiddenCalls > 0 && index === rows.length - 1;
				const color = other ? "var(--color-tool-other)" : toolColor(tool.name);
				const Icon = other ? Ellipsis : toolIcon(tool.name);
				const share = tool.calls / totalCalls;
				const style = {
					"--tool-color": color,
					"--tool-share": `${Math.max(3, share * 100)}%`,
				} as CSSProperties;
				return (
					<li key={tool.name} className="session-usage-tool-row" style={style}>
						<span className="session-usage-tool-icon" aria-hidden="true">
							<Icon className="size-3.5" strokeWidth={1.75} />
						</span>
						<span className="session-usage-tool-name truncate" title={tool.name}>
							{other ? tool.name : toolLabel(tool.name)}
						</span>
						<span className="session-usage-tool-bar" aria-hidden="true">
							<span className="session-usage-tool-fill" />
						</span>
						<strong className="inline-flex items-center justify-end gap-1.5">
							{tool.calls.toLocaleString(language)}
							{tool.failures > 0 && (
								<span
									className="inline-flex items-center gap-1 text-xs font-normal"
									title={t("session.usageToolFailures", { count: tool.failures })}
								>
									<span className="size-1 rounded-full bg-danger" aria-hidden="true" />
									<span aria-hidden="true">{tool.failures}</span>
									<span className="sr-only">{t("session.usageToolFailures", { count: tool.failures })}</span>
								</span>
							)}
						</strong>
						<small>{formatShare(share)}</small>
					</li>
				);
			})}
		</ul>
	);
}
