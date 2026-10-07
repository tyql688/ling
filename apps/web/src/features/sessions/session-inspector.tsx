import {
	SESSION_TRANSFER_MAX_BYTES,
	SESSION_TREE_PAGE_SIZE,
	type SessionInspection,
	type SessionInspectionBinding,
	type SessionControl,
} from "@ling/contracts/session-inspection";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
	DialogCloseButton,
} from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { Segmented } from "@renderer/components/ui/segmented";
import { Switch } from "@renderer/components/ui/switch";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { formatRequestError } from "@renderer/lib/errors";
import { sessionKey } from "@ling/contracts/session-ref";
import { sessionBusyFamily } from "./state/session";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SessionToolFilterForm } from "./session-tool-filter";
import type { SessionToolFilter } from "@ling/contracts/session-tool-filter";

type Tab = "overview" | "tools" | "tree" | "prompt" | "flags";

export function SessionInspector({
	binding,
	open,
	onOpenChange,
	onRestoreText,
}: {
	binding: SessionInspectionBinding | null;
	open: boolean;
	onOpenChange(open: boolean): void;
	onRestoreText(text: string): void;
}) {
	const { t } = useTranslation();
	const api = useDomainApi("session");
	// Tree navigation advances the runtime generation; recovered text belongs to the session.
	const [restored, setRestored] = useState<string | null>(null);
	const [selectedTab, setSelectedTab] = useState<{ session: string; tab: Tab } | null>(null);
	const [expandedFilter, setExpandedFilter] = useState<{ session: string; expanded: boolean } | null>(null);
	const [filterSubmission, setFilterSubmission] = useState<{
		session: string;
		filter: SessionToolFilter;
		pending: boolean;
		error: string | null;
	} | null>(null);
	const filterRequests = useRef(new Map<string, symbol>());
	useEffect(() => {
		const requests = filterRequests.current;
		return () => requests.clear();
	}, []);
	const currentSession = binding ? sessionKey(binding.ref) : null;
	const submission = filterSubmission?.session === currentSession ? filterSubmission : null;
	async function applyFilter(filter: SessionToolFilter) {
		if (!binding) return;
		const session = sessionKey(binding.ref);
		if (filterRequests.current.has(session)) return;
		const request = Symbol();
		filterRequests.current.set(session, request);
		setFilterSubmission({ session, filter, pending: true, error: null });
		try {
			await api.control({ ...binding, action: { type: "toolFilter", filter } });
			if (filterRequests.current.get(session) === request) {
				setFilterSubmission((current) => (current?.session === session ? null : current));
			}
		} catch (cause) {
			if (filterRequests.current.get(session) === request) {
				setFilterSubmission((current) =>
					current?.session === session ? { ...current, pending: false, error: formatRequestError(cause, t) } : current,
				);
			}
		} finally {
			if (filterRequests.current.get(session) === request) filterRequests.current.delete(session);
		}
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85dvh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col overflow-hidden">
				<div className="flex items-center justify-between gap-3">
					<DialogTitle>{t("sessionInspector.title")}</DialogTitle>
					<DialogCloseButton aria-label={t("common.close")} />
				</div>
				<DialogDescription>{t("sessionInspector.description")}</DialogDescription>
				{submission?.error && <FeedbackNotice tone="danger">{submission.error}</FeedbackNotice>}
				{restored && (
					<FeedbackNotice tone="info">
						<pre className="max-h-24 overflow-auto whitespace-pre-wrap">{restored}</pre>
						<Button
							size="sm"
							onClick={() => {
								onRestoreText(restored);
								setRestored(null);
							}}
						>
							{t("sessionInspector.restoreText")}
						</Button>
					</FeedbackNotice>
				)}
				{open && binding !== null && (
					<InspectionContent
						key={`${binding.ref.cwd}:${binding.ref.sessionId}:${binding.runtimeId}:${binding.generation}`}
						binding={binding}
						tab={selectedTab?.session === currentSession ? selectedTab.tab : "overview"}
						onTabChange={(tab) => setSelectedTab({ session: sessionKey(binding.ref), tab })}
						filterExpanded={expandedFilter?.session === currentSession && expandedFilter.expanded}
						onFilterExpandedChange={(expanded) => setExpandedFilter({ session: sessionKey(binding.ref), expanded })}
						filterDraft={submission?.filter}
						filterPending={submission?.pending ?? false}
						onApplyFilter={(filter) => void applyFilter(filter)}
						onRecoveredText={setRestored}
					/>
				)}
				{open && binding === null && <LoadingTransition label={t("settings.loading")} />}
			</DialogContent>
		</Dialog>
	);
}

function InspectionContent({
	binding,
	tab,
	onTabChange,
	filterExpanded,
	onFilterExpandedChange,
	filterDraft,
	filterPending,
	onApplyFilter,
	onRecoveredText,
}: {
	binding: SessionInspectionBinding;
	tab: Tab;
	onTabChange(tab: Tab): void;
	filterExpanded: boolean;
	onFilterExpandedChange(expanded: boolean): void;
	filterDraft: SessionToolFilter | undefined;
	filterPending: boolean;
	onApplyFilter(filter: SessionToolFilter): void;
	onRecoveredText(text: string): void;
}) {
	const api = useDomainApi("session");
	const busy = useAtomValue(sessionBusyFamily(sessionKey(binding.ref)));
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<SessionInspection | null>(null);
	const [offset, setOffset] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [actionInProgress, setPending] = useState(false);
	const pending = actionInProgress || filterPending;
	const actionPending = useRef(false);
	const upload = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [label, setLabel] = useState("");
	const [summarize, setSummarize] = useState(false);
	const [instructions, setInstructions] = useState("");
	const fence = useRef(0);
	const bindingRef = useRef(binding);
	bindingRef.current = binding;
	const load = useCallback(async () => {
		const revision = ++fence.current;
		try {
			const next = await api.inspect({ ...bindingRef.current, offset });
			if (revision === fence.current) {
				setSnapshot(next);
				setError(null);
			}
		} catch (cause) {
			if (revision === fence.current) setError(formatRequestError(cause, t));
		}
	}, [api, offset, t]);
	useEffect(() => {
		const owner = fence;
		void load();
		return () => {
			owner.current++;
		};
	}, [load]);
	async function act(action: SessionControl) {
		if (pending || actionPending.current) return;
		actionPending.current = true;
		setPending(true);
		setError(null);
		const revision = ++fence.current;
		try {
			const result = await api.control({ ...binding, action });
			if (!result.cancelled && result.editorText) onRecoveredText(result.editorText);
			if (revision !== fence.current) return;
			if (result.cancelled) setError(t("sessionInspector.cancelled"));
			else {
				await load();
			}
		} catch (cause) {
			if (revision === fence.current) setError(formatRequestError(cause, t));
		} finally {
			actionPending.current = false;
			setPending(false);
		}
	}
	async function importSession(file: File) {
		if (pending) return;
		if (file.size > SESSION_TRANSFER_MAX_BYTES) {
			setError(t("sessionInspector.importLimit"));
			return;
		}
		setPending(true);
		setError(null);
		try {
			const result = await api.import({ ...binding, content: await file.text() });
			if (result.cancelled) setError(t("sessionInspector.cancelled"));
		} catch (cause) {
			setError(formatRequestError(cause, t));
		} finally {
			setPending(false);
		}
	}
	async function exportSession(format: "html" | "jsonl") {
		setPending(true);
		setError(null);
		try {
			const result = await api.export({ ...binding, format });
			const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = result.name;
			anchor.click();
			// Release after the browser has admitted the download.
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (cause) {
			setError(formatRequestError(cause, t));
		} finally {
			setPending(false);
		}
	}
	return (
		<>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Segmented
					value={tab}
					onChange={onTabChange}
					options={(["overview", "tools", "tree", "prompt", "flags"] as const).map((value) => ({
						value,
						label: t(`sessionInspector.${value}`),
					}))}
				/>
				<Button size="sm" disabled={pending} onClick={() => void load()}>
					{t("projectPiConfig.refresh")}
				</Button>
			</div>
			{error && <FeedbackNotice tone="danger">{error}</FeedbackNotice>}
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{!snapshot ? (
					<LoadingTransition label={t("settings.loading")} />
				) : (
					<>
						{tab === "overview" && (
							<div className="flex flex-col gap-4">
								<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
									<dt>{t("sessionInspector.state")}</dt>
									<dd>{t(busy ? "sessionInspector.busy" : "sessionInspector.idle")}</dd>
									<dt>{t("sessionInspector.context")}</dt>
									<dd>
										{snapshot.context?.tokens === null || !snapshot.context
											? t("sessionInspector.unknown")
											: `${snapshot.context.tokens.toLocaleString()} / ${snapshot.context.contextWindow.toLocaleString()}`}
									</dd>
									<dt>{t("sessionInspector.tools")}</dt>
									<dd>
										{snapshot.tools.filter((tool) => tool.active).length} / {snapshot.tools.length}
									</dd>
									<dt>{t("sessionInspector.cache")}</dt>
									<dd>
										{snapshot.cache
											? t(`sessionInspector.cache_${snapshot.cache.state}`)
											: t("sessionInspector.unknown")}
									</dd>
								</dl>
								{snapshot.cache && (
									<div className="rounded-control border border-border-subtle p-3 text-sm">
										<p>{snapshot.cache.reason}</p>
										{snapshot.cache.nextWarmAt !== null && (
											<p>{new Date(snapshot.cache.nextWarmAt).toLocaleString()}</p>
										)}
										{snapshot.cache.warmCost !== null && (
											<p>
												{t("sessionInspector.warmCost")}: ${snapshot.cache.warmCost.toFixed(5)}
											</p>
										)}
										{snapshot.cache.expectedSavings !== null && (
											<p>
												{t("sessionInspector.savings")}: ${snapshot.cache.expectedSavings.toFixed(5)}
											</p>
										)}
										{snapshot.cache.extensionOverride && <p>{t("sessionInspector.extensionOverride")}</p>}
									</div>
								)}
								<div className="flex flex-wrap gap-2">
									<Button disabled={pending} onClick={() => void exportSession("html")}>
										{t("sessionInspector.exportHtml")}
									</Button>
									<Button disabled={pending} onClick={() => void exportSession("jsonl")}>
										{t("sessionInspector.exportJsonl")}
									</Button>
									<Button disabled={pending || busy} onClick={() => upload.current?.click()}>
										{t("sessionInspector.importJsonl")}
									</Button>
									<input
										ref={upload}
										type="file"
										accept=".jsonl"
										className="hidden"
										aria-label={t("sessionInspector.importJsonl")}
										onChange={(event) => {
											const file = event.target.files?.[0];
											event.target.value = "";
											if (file) void importSession(file);
										}}
									/>
								</div>
							</div>
						)}
						{tab === "tools" && (
							<>
								<SessionToolFilterForm
									key={JSON.stringify(filterDraft ?? snapshot.toolFilter)}
									filter={filterDraft ?? snapshot.toolFilter}
									expanded={filterExpanded}
									onExpandedChange={onFilterExpandedChange}
									busy={busy}
									pending={pending}
									onApply={onApplyFilter}
								/>
								<p className="mb-3 text-sm text-text-muted">{t("sessionInspector.toolsHint")}</p>
								<Input
									aria-label={t("sessionInspector.searchTools")}
									placeholder={t("sessionInspector.searchTools")}
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
								<div className="divide-y divide-border-subtle">
									{snapshot.tools
										.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
										.map((tool) => (
											<div key={tool.name} className="flex items-center gap-4 py-3">
												<div className="min-w-0 flex-1">
													<code className="break-all text-sm">{tool.name}</code>
													<p className="line-clamp-3 whitespace-pre-wrap text-xs text-text-muted">{tool.description}</p>
												</div>
												<Switch
													aria-label={tool.name}
													checked={tool.active}
													disabled={busy || pending}
													pending={pending}
													onCheckedChange={(enabled) =>
														void act({
															type: "tool",
															name: tool.name,
															enabled,
														})
													}
												/>
											</div>
										))}
								</div>
							</>
						)}
						{tab === "tree" && (
							<div className="flex flex-col gap-3">
								<p className="text-sm text-text-muted">{t("sessionInspector.treeHint")}</p>
								<div className="flex items-center justify-between">
									<Button
										aria-label={t("common.previousPage")}
										disabled={pending || offset === 0}
										onClick={() => {
											setOffset(Math.max(0, offset - SESSION_TREE_PAGE_SIZE));
											setSelected(null);
										}}
									>
										←
									</Button>
									<span className="text-xs tabular-nums">
										{snapshot.total === 0 ? 0 : offset + 1}–{Math.min(offset + SESSION_TREE_PAGE_SIZE, snapshot.total)}{" "}
										/ {snapshot.total}
									</span>
									<Button
										aria-label={t("common.nextPage")}
										disabled={pending || offset + SESSION_TREE_PAGE_SIZE >= snapshot.total}
										onClick={() => {
											setOffset(offset + SESSION_TREE_PAGE_SIZE);
											setSelected(null);
										}}
									>
										→
									</Button>
								</div>
								<div className="max-h-72 overflow-auto rounded-control border border-border-subtle">
									{snapshot.entries.map((entry) => (
										<button
											type="button"
											key={entry.id}
											aria-pressed={selected === entry.id}
											style={{ paddingInlineStart: `${12 + Math.min(entry.branchDepth, 8) * 16}px` }}
											onClick={() => {
												setSelected(entry.id);
												setLabel(entry.label ?? "");
											}}
											className={`block w-full border-b border-border-subtle px-3 py-2 text-left hover:bg-surface-hover ${selected === entry.id ? "bg-surface-hover" : ""}`}
										>
											<span className="block text-xs text-text-muted">
												{t(`sessionInspector.entries.${entry.role ?? entry.type}`, {
													defaultValue: entry.role ?? entry.type,
												})}{" "}
												· {new Date(entry.timestamp).toLocaleString()} {entry.id === snapshot.leafId ? "●" : ""}
												{entry.onCurrentBranch ? ` · ${t("sessionInspector.currentBranch")}` : ""}
											</span>
											<span className="line-clamp-2 whitespace-pre-wrap text-sm">
												{entry.label ||
													entry.text ||
													t(`sessionInspector.entries.${entry.role ?? entry.type}`, {
														defaultValue: entry.role ?? entry.type,
													})}
											</span>
										</button>
									))}
								</div>
								{selected && (
									<>
										<div className="flex gap-2">
											<Input
												aria-label={t("sessionInspector.label")}
												value={label}
												onChange={(event) => setLabel(event.target.value)}
											/>
											<Button
												disabled={pending || busy}
												onClick={() => void act({ type: "label", entryId: selected, label })}
											>
												{t("common.save")}
											</Button>
										</div>
										<label className="flex items-center gap-2 text-sm">
											<Switch checked={summarize} onCheckedChange={setSummarize} />
											{t("sessionInspector.summarize")}
										</label>
										{summarize && (
											<Textarea
												aria-label={t("sessionInspector.instructions")}
												placeholder={t("sessionInspector.instructions")}
												value={instructions}
												onChange={(event) => setInstructions(event.target.value)}
											/>
										)}
										<Button
											disabled={pending || busy || selected === snapshot.leafId}
											onClick={() =>
												void act({
													type: "navigate",
													entryId: selected,
													summarize,
													...(instructions ? { customInstructions: instructions } : {}),
												})
											}
										>
											{pending ? t("piConfiguration.applying") : t("sessionInspector.navigate")}
										</Button>
									</>
								)}
							</div>
						)}
						{tab === "prompt" && (
							<>
								{snapshot.systemPromptTruncated && (
									<FeedbackNotice tone="warning">{t("sessionInspector.truncated")}</FeedbackNotice>
								)}
								<pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">{snapshot.systemPrompt}</pre>
							</>
						)}
						{tab === "flags" && (
							<>
								<p className="mb-3 text-sm text-text-muted">{t("sessionInspector.flagsHint")}</p>
								{snapshot.flags.length === 0 && (
									<p className="text-sm text-text-muted">{t("sessionInspector.noFlags")}</p>
								)}
								{snapshot.flags.map((flag) => (
									<div key={flag.name} className="flex flex-col gap-2 border-b border-border-subtle py-3">
										<code>{flag.name}</code>
										<p className="text-xs text-text-muted">{flag.description}</p>
										{flag.type === "boolean" ? (
											<Switch
												aria-label={flag.name}
												checked={flag.value === true}
												disabled={pending || busy}
												onCheckedChange={(value) => void act({ type: "flag", name: flag.name, value })}
											/>
										) : (
											<form
												className="flex gap-2"
												onSubmit={(event) => {
													event.preventDefault();
													const value = new FormData(event.currentTarget).get("value");
													if (typeof value === "string") void act({ type: "flag", name: flag.name, value });
												}}
											>
												<Input
													key={String(flag.value)}
													name="value"
													aria-label={flag.name}
													defaultValue={String(flag.value ?? "")}
													disabled={pending || busy}
												/>
												<Button type="submit" disabled={pending || busy}>
													{t("common.save")}
												</Button>
											</form>
										)}
									</div>
								))}
							</>
						)}
					</>
				)}
			</div>
		</>
	);
}
