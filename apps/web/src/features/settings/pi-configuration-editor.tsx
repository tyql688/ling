import {
	PI_GLOBAL_CONFIGURATION_KEYS,
	PI_TERMINAL_CONFIGURATION_KEYS,
	piConfigurationSettingsSchema,
	type PiConfigurationSnapshot,
} from "@ling/contracts/pi-configuration";
import type { BoundedJsonObject } from "@ling/contracts/bounded-json";
import type { PiResourceReloadSummary } from "@ling/contracts/session";
import { ResourceReloadFeedback } from "@renderer/components/resource-reload-feedback";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { Switch } from "@renderer/components/ui/switch";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { formatRequestError } from "@renderer/lib/errors";
import { atom, useAtom } from "jotai";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const configurableKeys = [
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"modelThinkingLevels",
	"thinkingBudgets",
	"enabledModels",
	"defaultTools",
	"transport",
	"websocketConnectTimeoutMs",
	"httpIdleTimeoutMs",
	"compaction",
	"branchSummary",
	"retry",
	"cacheWarming",
	"shellPath",
	"shellCommandPrefix",
	"npmCommand",
	"sessionDir",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"packages",
	"enableSkillCommands",
	"images",
	"codemode",
	"warnings",
	"hideThinkingBlock",
	"showCacheMissNotices",
];

interface ConfigurationDraft {
	key: string | null;
	text: string;
	base: PiConfigurationSnapshot;
}
// Unsaved edits belong to their configuration path and survive settings navigation.
const configurationDraftsAtom = atom<Record<string, ConfigurationDraft>>({});

/** Scoped drafts survive navigation; reads and saves have independent lifetimes. */
export function PiConfigurationEditor({
	cwd,
	onDirtyChange,
}: {
	cwd: string | null;
	onDirtyChange?: (dirty: boolean) => void;
}) {
	const { t } = useTranslation();
	const api = useDomainApi("piSettings");
	const [snapshot, setSnapshot] = useState<PiConfigurationSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [reload, setReload] = useState<PiResourceReloadSummary | null>(null);
	const [query, setQuery] = useState("");
	const [drafts, setDrafts] = useAtom(configurationDraftsAtom);
	const owner = cwd ?? "global";
	const savedDraft = drafts[owner];
	const editing = savedDraft?.key ?? null;
	const draft = savedDraft?.text ?? "";
	const raw = savedDraft?.key === null;
	const [pendingKey, setPendingKey] = useState<string | null>(null);
	function setDraft(next: ConfigurationDraft | null) {
		setDrafts((current) => {
			const updated = { ...current };
			if (next) updated[owner] = next;
			else delete updated[owner];
			return updated;
		});
	}
	const loadGeneration = useRef(0);
	const saveGeneration = useRef(0);
	const draftId = useId();
	const focusDraft = useCallback((element: HTMLTextAreaElement | null) => {
		element?.focus();
	}, []);
	useEffect(() => {
		onDirtyChange?.(raw || editing !== null || pending);
	}, [raw, editing, pending, onDirtyChange]);
	const load = useCallback(async () => {
		const revision = ++loadGeneration.current;
		try {
			const next = await api.configuration({ cwd });
			if (revision !== loadGeneration.current) return;
			setSnapshot(next);
			setError(null);
		} catch (cause) {
			if (revision === loadGeneration.current) setError(formatRequestError(cause, t));
		}
	}, [api, cwd, t]);
	useEffect(() => {
		const owner = loadGeneration;
		void load();
		return () => {
			owner.current++;
		};
	}, [load]);
	useEffect(() => {
		const owner = saveGeneration;
		return () => {
			owner.current++;
		};
	}, []);
	async function save(settings: BoundedJsonObject, expectedRevision = snapshot?.revision, key: string | null = null) {
		if (!snapshot || !expectedRevision || pending) return;
		setPending(true);
		setPendingKey(key);
		setError(null);
		const revision = ++saveGeneration.current;
		const submittedDraft = savedDraft;
		try {
			const result = await api.writeConfiguration({
				cwd,
				revision: expectedRevision,
				settings: piConfigurationSettingsSchema.parse(settings),
			});
			if (submittedDraft)
				setDrafts((current) => {
					if (current[owner] !== submittedDraft) return current;
					const next = { ...current };
					delete next[owner];
					return next;
				});
			if (revision !== saveGeneration.current) return;
			loadGeneration.current++;
			setSnapshot(result.configuration);
			setReload(result.reload);
		} catch (cause) {
			if (revision === saveGeneration.current) setError(formatRequestError(cause, t));
		} finally {
			if (revision === saveGeneration.current) {
				setPending(false);
				setPendingKey(null);
			}
		}
	}
	function saveDraft() {
		if (!savedDraft) return;
		try {
			const settings = raw ? JSON.parse(draft) : { ...savedDraft.base.configured, [editing!]: JSON.parse(draft) };
			void save(piConfigurationSettingsSchema.parse(settings), savedDraft.base.revision, editing);
		} catch (cause) {
			setError(formatRequestError(cause, t));
		}
	}
	function mergeCurrentConfiguration() {
		if (!savedDraft || !snapshot) return;
		try {
			let text = savedDraft.text;
			if (savedDraft.key === null) {
				const edited = piConfigurationSettingsSchema.parse(JSON.parse(text));
				const merged = { ...snapshot.configured };
				for (const key of new Set([...Object.keys(savedDraft.base.configured), ...Object.keys(edited)])) {
					if (JSON.stringify(savedDraft.base.configured[key]) === JSON.stringify(edited[key])) continue;
					if (Object.hasOwn(edited, key)) merged[key] = edited[key]!;
					else delete merged[key];
				}
				text = JSON.stringify(merged, null, 2);
			}
			setDraft({ ...savedDraft, text, base: snapshot });
			setError(null);
		} catch (cause) {
			setError(formatRequestError(cause, t));
		}
	}
	if (!snapshot)
		return error ? (
			<FeedbackNotice tone="danger">
				{error}
				<Button onClick={() => void load()}>{t("common.retry")}</Button>
			</FeedbackNotice>
		) : (
			<LoadingTransition label={t("settings.loading")} />
		);
	const keys = [
		...new Set([
			...configurableKeys,
			...Object.keys(snapshot.configured),
			...Object.keys(snapshot.inherited),
			...Object.keys(snapshot.resolved),
		]),
	].filter((key) => key.toLowerCase().includes(query.toLowerCase()));
	return (
		<div className="flex min-h-0 flex-col gap-3">
			<p className="text-sm text-text-muted">{t("piConfiguration.description")}</p>
			<code className="break-all text-xs text-text-muted">{snapshot.path}</code>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					aria-label={t("piConfiguration.search")}
					placeholder={t("piConfiguration.search")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					className="min-w-40 flex-1"
				/>
				<Button disabled={pending} onClick={() => void load()}>
					{t("projectPiConfig.refresh")}
				</Button>
				<Button
					disabled={pending || !snapshot.trusted || raw || editing !== null}
					onClick={() => {
						setDraft({ key: null, text: JSON.stringify(snapshot.configured, null, 2), base: snapshot });
					}}
				>
					{t("piConfiguration.editJson")}
				</Button>
			</div>
			{!snapshot.trusted && <FeedbackNotice tone="warning">{t("projectPiConfig.untrustedDescription")}</FeedbackNotice>}
			{error && <FeedbackNotice tone="danger">{error}</FeedbackNotice>}
			{snapshot.diagnostics.map((diagnostic) => (
				<FeedbackNotice key={diagnostic} tone="warning">
					{diagnostic}
				</FeedbackNotice>
			))}
			{reload && <ResourceReloadFeedback summary={reload} />}
			{savedDraft && savedDraft.base.revision !== snapshot.revision && (
				<FeedbackNotice tone="warning">
					{t("piConfiguration.conflict")}
					<Button disabled={pending} onClick={mergeCurrentConfiguration}>
						{t("piConfiguration.mergeDraft")}
					</Button>
				</FeedbackNotice>
			)}
			{(raw || editing !== null) && (
				<div className="flex flex-col gap-2 rounded-control border border-border-subtle p-3">
					<label className="text-sm font-medium" htmlFor={draftId}>
						{raw ? t("piConfiguration.editJson") : editing}
					</label>
					<Textarea
						ref={focusDraft}
						id={draftId}
						value={draft}
						disabled={pending}
						onChange={(event) => savedDraft && setDraft({ ...savedDraft, text: event.target.value })}
						rows={raw ? 16 : 6}
						className="font-mono"
					/>
					<p className="text-xs text-text-muted">{t("piConfiguration.jsonHint")}</p>
					<div className="flex gap-2">
						<Button disabled={pending} onClick={saveDraft}>
							{pending ? t("piConfiguration.applying") : t("common.save")}
						</Button>
						<Button
							variant="ghost"
							disabled={pending}
							onClick={() => {
								setDraft(null);
							}}
						>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			)}
			<div className="divide-y divide-border-subtle">
				{keys.map((key) => {
					const configured = Object.hasOwn(snapshot.configured, key);
					const globalOnly = (PI_GLOBAL_CONFIGURATION_KEYS as readonly string[]).includes(key);
					const terminal = (PI_TERMINAL_CONFIGURATION_KEYS as readonly string[]).includes(key);
					const value = snapshot.resolved[key];
					const source =
						configured && snapshot.trusted && !(cwd !== null && globalOnly)
							? cwd
								? "project"
								: "global"
							: Object.hasOwn(snapshot.inherited, key)
								? "global"
								: "default";
					const disabled = pending || !snapshot.trusted || (cwd !== null && globalOnly) || raw || editing !== null;
					return (
						<div key={key} className="flex flex-wrap items-start gap-3 py-3">
							<div className="min-w-0 flex-1 basis-52">
								<div className="flex flex-wrap items-center gap-2">
									<code className="break-all text-sm">{key}</code>
									<span className="text-xs text-text-muted">
										{t(`piConfiguration.source_${source}`)}
										{terminal ? ` · ${t("piConfiguration.terminal")}` : ""}
										{globalOnly ? ` · ${t("piConfiguration.globalOnly")}` : ""}
									</span>
								</div>
								<pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all text-xs text-text-muted">
									{value === undefined ? t("piConfiguration.automatic") : JSON.stringify(value, null, 2)}
								</pre>
								{configured && JSON.stringify(snapshot.configured[key]) !== JSON.stringify(value) && (
									<p className="mt-1 break-all text-xs text-text-muted">
										{t("piConfiguration.stored")}: <code>{JSON.stringify(snapshot.configured[key])}</code>
									</p>
								)}
							</div>
							<div className="flex items-center gap-2">
								{typeof value === "boolean" && (
									<Switch
										aria-label={key}
										checked={value}
										disabled={disabled}
										pending={pending && pendingKey === key}
										onCheckedChange={(enabled) =>
											void save({ ...snapshot.configured, [key]: enabled }, snapshot.revision, key)
										}
									/>
								)}
								<Button
									size="sm"
									variant="outline"
									disabled={disabled}
									onClick={() => {
										setDraft({
											key,
											text: JSON.stringify(snapshot.configured[key] ?? value ?? "", null, 2),
											base: snapshot,
										});
									}}
								>
									{t("common.edit")}
								</Button>
								{configured && (
									<Button
										size="sm"
										variant="ghost"
										disabled={disabled}
										onClick={() => {
											const next = { ...snapshot.configured };
											delete next[key];
											void save(next, snapshot.revision, key);
										}}
									>
										{t("piConfiguration.inherit")}
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
