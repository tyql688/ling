import { sessionToolFilterSchema, type SessionToolFilter } from "@ling/contracts/session-tool-filter";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function SessionToolFilterForm({
	filter,
	expanded,
	onExpandedChange,
	busy,
	pending,
	onApply,
}: {
	filter: SessionToolFilter;
	expanded: boolean;
	onExpandedChange(expanded: boolean): void;
	busy: boolean;
	pending: boolean;
	onApply(filter: SessionToolFilter): void;
}) {
	const { t } = useTranslation();
	const [mode, setMode] = useState(filter.tools === null ? "defaults" : filter.tools.length ? "custom" : "none");
	const [allowed, setAllowed] = useState(filter.tools?.join("\n") ?? "");
	const [excluded, setExcluded] = useState(filter.excludeTools.join("\n"));
	const [disableMcp, setDisableMcp] = useState(filter.disableMcp);
	const [invalid, setInvalid] = useState(false);
	const split = (value: string) => [
		...new Set(
			value
				.split(/[,\n]/)
				.map((pattern) => pattern.trim())
				.filter(Boolean),
		),
	];
	return (
		<details
			open={expanded}
			onToggle={(event) => onExpandedChange(event.currentTarget.open)}
			className="mb-4 rounded-control border border-border-subtle p-3"
		>
			<summary className="cursor-pointer text-sm font-medium">{t("sessionInspector.toolFilter.title")}</summary>
			<form
				className="mt-3 flex flex-col gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (busy || pending) return;
					const parsed = sessionToolFilterSchema.safeParse({
						tools: mode === "defaults" ? null : mode === "none" ? [] : split(allowed),
						excludeTools: split(excluded),
						disableMcp,
					});
					if (!parsed.success || (mode === "custom" && parsed.data.tools?.length === 0)) {
						setInvalid(true);
						return;
					}
					setInvalid(false);
					onApply(parsed.data);
				}}
			>
				<p className="text-xs text-text-muted">{t("sessionInspector.toolFilter.hint")}</p>
				<Select value={mode} onValueChange={setMode} disabled={busy || pending}>
					<SelectTrigger aria-label={t("sessionInspector.toolFilter.mode")}>
						<SelectValue>{t(`sessionInspector.toolFilter.${mode}`)}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{["defaults", "custom", "none"].map((value) => (
							<SelectItem key={value} value={value}>
								{t(`sessionInspector.toolFilter.${value}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{mode === "custom" && (
					<label className="flex flex-col gap-1 text-sm">
						{t("sessionInspector.toolFilter.allow")}
						<Textarea
							value={allowed}
							onChange={(event) => setAllowed(event.target.value)}
							disabled={busy || pending}
							placeholder="read, codemode, mcp__docs__*"
							rows={2}
						/>
					</label>
				)}
				<label className="flex flex-col gap-1 text-sm">
					{t("sessionInspector.toolFilter.exclude")}
					<Textarea
						value={excluded}
						onChange={(event) => setExcluded(event.target.value)}
						disabled={busy || pending}
						placeholder="bash, mcp__*__delete*"
						rows={2}
					/>
				</label>
				<p className="text-xs text-text-muted">{t("sessionInspector.toolFilter.mcpHint")}</p>
				<label className="flex items-center justify-between gap-3 text-sm">
					{t("sessionInspector.toolFilter.disableMcp")}
					<Switch checked={disableMcp} onCheckedChange={setDisableMcp} disabled={busy || pending} />
				</label>
				<p className="text-xs text-text-muted">{t("sessionInspector.toolFilter.mcpOverrideHint")}</p>
				{invalid && <FeedbackNotice tone="danger">{t("sessionInspector.toolFilter.invalid")}</FeedbackNotice>}
				<Button type="submit" className="self-start" disabled={busy} pending={pending}>
					{t(pending ? "piConfiguration.applying" : "sessionInspector.toolFilter.apply")}
				</Button>
			</form>
		</details>
	);
}
