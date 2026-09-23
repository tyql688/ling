import { PiCompactionSettings } from "./pi-compaction-settings";
import { ChoiceButton } from "@renderer/components/ui/choice-button";
import {
	HTTP_IDLE_TIMEOUT_CHOICES_MS,
	PI_BUILT_IN_TOOL_NAMES,
	PI_CACHE_WARMING_MODES,
	PI_RETRY_MAX_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MIN,
	PI_RETRY_MAX_RETRIES_MAX,
	PI_RETRY_MAX_RETRIES_MIN,
	type DefaultProjectTrust,
	type MessageDeliveryMode,
	type PiSettingsRecoveryStatus,
	type PiSettingsSnapshot,
	type PiSettingsUpdate,
} from "@ling/contracts/pi-settings";
import { piSettingsUpdateSchema } from "@ling/contracts/pi-settings-requests";
import { THINKING_LEVELS, type ThinkingLevel } from "@ling/contracts/session";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { Segmented } from "@renderer/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { SettingsFieldRow, SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { Switch } from "@renderer/components/ui/switch";
import { ModelPicker } from "@renderer/features/models/model-picker";
import { isProviderUsable } from "@renderer/features/models/models-navigation";
import { useProviders } from "@renderer/features/models/use-providers";
import { GlobalInstructionsSection } from "@renderer/features/settings/global-instructions-section";
import { NumberSettingRow } from "@renderer/components/ui/number-setting-row";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { isWindows } from "@renderer/lib/platform";
import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TextSettingRow } from "@renderer/components/ui/text-setting-row";

type ProxySettingReadResult = { status: "ready"; value: string } | { status: "unavailable"; error: unknown };

type PersistedSettingsMutationResult<Success, Persisted> =
	| { status: "saved"; value: Success }
	| {
			status: "failed";
			error: unknown;
			persisted: { status: "ready"; value: Persisted } | { status: "unavailable"; error: unknown };
	  };

/** A main-process mutation can persist successfully and still reject because live
 * Pi generations failed to reload. Always read the canonical saved value after a
 * rejection so the settings UI never keeps presenting a stale pre-save snapshot. */
async function runPersistedSettingsMutation<Success, Persisted>(
	mutate: () => Promise<Success>,
	readPersisted: () => Promise<Persisted>,
): Promise<PersistedSettingsMutationResult<Success, Persisted>> {
	try {
		return { status: "saved", value: await mutate() };
	} catch (error) {
		try {
			return { status: "failed", error, persisted: { status: "ready", value: await readPersisted() } };
		} catch (readError) {
			return { status: "failed", error, persisted: { status: "unavailable", error: readError } };
		}
	}
}

interface PersistedSettingsMutationQueue {
	run<Success, Persisted>(
		mutate: () => Promise<Success>,
		readPersisted: () => Promise<Persisted>,
	): Promise<{ revision: number; result: PersistedSettingsMutationResult<Success, Persisted> }>;
	isCurrent(revision: number): boolean;
	invalidate(): void;
}

interface SettingsReadFence {
	begin(): number;
	isCurrent(revision: number): boolean;
	invalidate(): void;
}

/** Prevents an older settings read from publishing after a newer read, edit, or
 * mutation has taken ownership of the visible state. Reads and mutations have
 * separate lifetimes, so this fence deliberately stays independent of the write queue. */
function createSettingsReadFence(): SettingsReadFence {
	let latestRevision = 0;
	return {
		begin() {
			latestRevision += 1;
			return latestRevision;
		},
		isCurrent(revision) {
			return revision === latestRevision;
		},
		invalidate() {
			latestRevision += 1;
		},
	};
}

/** Serializes global settings writes and lets the renderer publish only the newest
 * requested snapshot. Main already serializes disk writes; this closes the separate
 * response-order window in React, including canonical reads after reload failures. */
function createPersistedSettingsMutationQueue(): PersistedSettingsMutationQueue {
	let latestRevision = 0;
	let tail: Promise<void> = Promise.resolve();
	return {
		run(mutate, readPersisted) {
			latestRevision += 1;
			const revision = latestRevision;
			const operation = tail.then(() => runPersistedSettingsMutation(mutate, readPersisted));
			tail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation.then((result) => ({ revision, result }));
		},
		isCurrent(revision) {
			return revision === latestRevision;
		},
		invalidate() {
			latestRevision += 1;
		},
	};
}

async function readProxySetting(read: () => Promise<string | null>): Promise<ProxySettingReadResult> {
	try {
		return { status: "ready", value: (await read()) ?? "" };
	} catch (error) {
		return { status: "unavailable", error };
	}
}

/** Proxy absence is Pi's automatic network mode; failed reads stay distinct. */
function ProxyRow() {
	const hostNetworkApi = useDomainApi("network");
	const { t } = useTranslation();
	const [stored, setStored] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fence = useRef(createSettingsReadFence()).current;
	const queue = useRef(createPersistedSettingsMutationQueue()).current;
	const load = useCallback(async () => {
		const revision = fence.begin();
		const result = await readProxySetting(hostNetworkApi.getProxy);
		if (!fence.isCurrent(revision)) return;
		if (result.status === "ready") {
			setStored(result.value);
			setError(null);
		} else setError(formatRequestError(result.error, t));
	}, [hostNetworkApi, fence, t]);
	useEffect(() => {
		void load();
		return () => {
			fence.invalidate();
			queue.invalidate();
		};
	}, [load, fence, queue]);
	const save = async (draft: string): Promise<boolean> => {
		fence.invalidate();
		const next = draft.trim();
		const outcome = await queue.run(() => hostNetworkApi.setProxy(next === "" ? null : next), hostNetworkApi.getProxy);
		if (!queue.isCurrent(outcome.revision)) return outcome.result.status === "saved";
		const { result } = outcome;
		if (result.status === "saved") {
			setStored(next);
			setError(null);
			return true;
		}
		if (result.persisted.status === "ready") setStored(result.persisted.value ?? "");
		setError(formatRequestError(result.error, t));
		return false;
	};
	if (stored === null)
		return error ? (
			<SettingsState
				compact
				title={t("settings.httpProxy")}
				description={error}
				tone="danger"
				action={<SettingsRetryAction label={t("common.retry")} onClick={() => void load()} />}
			/>
		) : (
			<LoadingTransition label={t("settings.loading")} />
		);
	return (
		<TextSettingRow
			label={t("settings.httpProxy")}
			description={error ?? t("settings.httpProxyDescription")}
			value={stored}
			placeholder="http://127.0.0.1:7890"
			onSave={save}
		/>
	);
}

/**
 * The GUI face of pi's /settings, curated to agent behavior (the CLI panel's TUI-only
 * entries — terminal themes, image cells, cursor — stay in the CLI). Controls persist
 * to Pi's global settings.json and refresh every open project's SettingsManager.
 */
export function PiSettingsView() {
	const hostPiSettingsApi = useDomainApi("piSettings");

	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<PiSettingsSnapshot | null>(null);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [recoveryStatus, setRecoveryStatus] = useState<PiSettingsRecoveryStatus | null>(null);
	const [repairing, setRepairing] = useState(false);
	const { providers, error: providersError, refresh: refreshProviders } = useProviders();
	const mutationQueueRef = useRef<PersistedSettingsMutationQueue | null>(null);
	mutationQueueRef.current ??= createPersistedSettingsMutationQueue();
	const mutationQueue = mutationQueueRef.current;
	const readFenceRef = useRef<SettingsReadFence | null>(null);
	readFenceRef.current ??= createSettingsReadFence();
	const readFence = readFenceRef.current;
	useEffect(
		() => () => {
			readFence.invalidate();
			mutationQueue.invalidate();
		},
		[mutationQueue, readFence],
	);

	const load = useCallback(async () => {
		const revision = readFence.begin();
		try {
			const nextSnapshot = await hostPiSettingsApi.get();
			if (!readFence.isCurrent(revision)) return;
			setSnapshot(nextSnapshot);
			setSettingsError(null);
			setRecoveryStatus(null);
		} catch (cause) {
			if (!readFence.isCurrent(revision)) return;
			const nextError = formatRequestError(cause, t);
			try {
				const nextRecoveryStatus = await hostPiSettingsApi.getRecoveryStatus();
				if (!readFence.isCurrent(revision)) return;
				setSettingsError(nextError);
				setRecoveryStatus(nextRecoveryStatus);
			} catch {
				if (!readFence.isCurrent(revision)) return;
				setSettingsError(nextError);
				setRecoveryStatus({ status: "unavailable", code: "PI_SETTINGS_READ_FAILED" });
			}
		}
	}, [hostPiSettingsApi, readFence, t]);

	useEffect(() => {
		void load();
	}, [load]);

	const repairHttpIdleTimeout = async () => {
		readFence.invalidate();
		setRepairing(true);
		try {
			const outcome = await mutationQueue.run(hostPiSettingsApi.repairHttpIdleTimeout, hostPiSettingsApi.get);
			if (!mutationQueue.isCurrent(outcome.revision)) return;
			const { result } = outcome;
			if (result.status === "saved") {
				setSnapshot(result.value);
				setSettingsError(null);
				setRecoveryStatus(null);
			} else {
				if (result.persisted.status === "ready") {
					setSnapshot(result.persisted.value);
					setRecoveryStatus(null);
				}
				setSettingsError(formatRequestError(result.error, t));
			}
		} finally {
			setRepairing(false);
		}
	};

	const usableProviders = useMemo(
		() => (providers ?? []).filter((provider) => isProviderUsable(provider) && provider.models.length > 0),
		[providers],
	);
	const modelOptions = useMemo(
		() =>
			usableProviders.flatMap((provider) =>
				provider.models.map((model) => ({
					provider: provider.id,
					providerName: provider.displayName,
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
				})),
			),
		[usableProviders],
	);

	const apply = async (update: PiSettingsUpdate | (() => PiSettingsUpdate)): Promise<boolean> => {
		readFence.invalidate();
		const outcome = await mutationQueue.run(
			() => hostPiSettingsApi.update(typeof update === "function" ? update() : update),
			hostPiSettingsApi.get,
		);
		if (!mutationQueue.isCurrent(outcome.revision)) return outcome.result.status === "saved";
		const { result } = outcome;
		if (result.status === "saved") {
			setSnapshot(result.value);
			setSettingsError(null);
			return true;
		}
		if (result.persisted.status === "ready") setSnapshot(result.persisted.value);
		setSettingsError(formatRequestError(result.error, t));
		return false;
	};

	if (!snapshot) {
		return (
			<SettingsPage title={t("settings.pi")}>
				{settingsError ? (
					<SettingsState
						icon={Settings2}
						title={t("settings.piLoadFailed")}
						description={
							<>
								<span>{settingsError}</span>
								{recoveryStatus?.status === "recoveryRequired" && (
									<span className="mt-1 block">{t("settings.invalidHttpIdleTimeoutRecovery")}</span>
								)}
							</>
						}
						tone="danger"
						action={
							<>
								<SettingsRetryAction label={t("session.retry")} disabled={repairing} onClick={() => void load()} />
								{recoveryStatus?.status === "recoveryRequired" && (
									<Button size="sm" disabled={repairing} onClick={() => void repairHttpIdleTimeout()}>
										{t("settings.repairHttpIdleTimeout")}
									</Button>
								)}
							</>
						}
					/>
				) : (
					<LoadingTransition label={t("settings.piLoading")} />
				)}
			</SettingsPage>
		);
	}

	const defaultModelValue =
		snapshot.defaultProvider !== null && snapshot.defaultModel !== null
			? { provider: snapshot.defaultProvider, id: snapshot.defaultModel }
			: null;
	const defaultModelName = modelOptions.find(
		(model) => model.provider === snapshot.defaultProvider && model.id === snapshot.defaultModel,
	)?.name;

	const timeoutLabel = (ms: number) =>
		ms === 0 ? t("settings.timeoutDisabled") : ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000}min`;

	const deliveryOptions: { value: MessageDeliveryMode; label: string }[] = [
		{ value: "all", label: t("settings.delivery_all") },
		{ value: "one-at-a-time", label: t("settings.delivery_one") },
	];

	const projectTrustOptions: { value: DefaultProjectTrust; label: string }[] = [
		{ value: "ask", label: t("settings.projectTrust_ask") },
		{ value: "always", label: t("settings.projectTrust_always") },
		{ value: "never", label: t("settings.projectTrust_never") },
	];

	return (
		<SettingsPage title={t("settings.pi")}>
			<GlobalInstructionsSection />
			{settingsError && (
				<FeedbackNotice
					tone="danger"
					title={t("settings.piSaveFailed")}
					action={<SettingsRetryAction label={t("session.retry")} onClick={() => void load()} />}
				>
					{settingsError}
				</FeedbackNotice>
			)}
			{providersError && (
				<FeedbackNotice
					tone="danger"
					title={t("models.loadFailed")}
					action={<SettingsRetryAction label={t("models.retry")} onClick={() => void refreshProviders()} />}
				>
					{providersError}
				</FeedbackNotice>
			)}
			<SettingsSection title={t("settings.piDefaults")}>
				<SettingsFieldRow label={t("settings.defaultModel")}>
					{({ controlId, labelId, descriptionId }) => (
						<ModelPicker
							options={modelOptions}
							selected={defaultModelValue}
							defaultModel={defaultModelValue}
							onSelect={(model) => void apply({ type: "defaultModel", provider: model.provider, modelId: model.id })}
							triggerId={controlId}
							triggerAriaLabelledBy={labelId}
							triggerAriaDescribedBy={descriptionId}
							triggerClassName="h-8 max-w-56 rounded-control border border-border-subtle bg-surface px-2.5 text-sm text-text-primary hover:bg-surface-hover"
						>
							<span className="min-w-0 truncate">{defaultModelName ?? snapshot.defaultModel ?? "—"}</span>
						</ModelPicker>
					)}
				</SettingsFieldRow>
				<SettingsFieldRow label={t("settings.defaultThinking")}>
					{({ controlId, labelId, descriptionId }) => (
						<Select
							value={snapshot.defaultThinkingLevel}
							onValueChange={(value) => {
								if (value) void apply({ type: "thinkingLevel", level: value as ThinkingLevel });
							}}
						>
							<SelectTrigger id={controlId} aria-labelledby={labelId} aria-describedby={descriptionId} className="h-8">
								<SelectValue>
									{() =>
										snapshot.defaultThinkingLevel === null
											? "—"
											: t(`session.thinkingLevel_${snapshot.defaultThinkingLevel}`)
									}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{THINKING_LEVELS.map((level) => (
									<SelectItem key={level} value={level}>
										{t(`session.thinkingLevel_${level}`)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</SettingsFieldRow>
				<SettingsFieldRow
					group
					layout="stacked"
					label={t("settings.defaultTools")}
					description={t("settings.defaultToolsDescription")}
				>
					{({ labelId, descriptionId }) => (
						<div
							role="group"
							aria-labelledby={labelId}
							aria-describedby={descriptionId}
							className="@container/default-tools min-w-0 w-full"
						>
							{/* Each column leaves room for the Windows powershell label and its selection mark. */}
							<div className="grid grid-cols-1 gap-2 @min-[18rem]/default-tools:grid-cols-2 @min-[34rem]/default-tools:grid-cols-4">
								{PI_BUILT_IN_TOOL_NAMES.filter((tool) => tool !== "powershell" || isWindows).map((tool) => {
									const selected = snapshot.defaultTools.includes(tool);
									return (
										<ChoiceButton
											key={tool}
											type="button"
											selected={selected}
											onClick={() =>
												void apply(() =>
													piSettingsUpdateSchema.parse({
														type: "defaultTools",
														tools: selected
															? snapshot.defaultTools.filter((name) => name !== tool)
															: [...snapshot.defaultTools, tool],
													}),
												)
											}
											className="w-full justify-between font-mono text-xs"
										>
											<span className="min-w-0 break-all text-start">{tool}</span>
										</ChoiceButton>
									);
								})}
							</div>
						</div>
					)}
				</SettingsFieldRow>
			</SettingsSection>

			<SettingsSection title={t("settings.piBehavior")}>
				<SettingsRow layout="toggle" label={t("settings.compaction")} description={t("settings.compactionDescription")}>
					<Switch
						checked={snapshot.compactionEnabled}
						onCheckedChange={(enabled) => void apply({ type: "compaction", enabled })}
						aria-label={t("settings.compaction")}
					/>
				</SettingsRow>
				<PiCompactionSettings snapshot={snapshot} models={modelOptions} apply={apply} />
				<SettingsFieldRow label={t("settings.cacheWarming")} description={t("settings.cacheWarmingDescription")}>
					{({ labelId, descriptionId }) => (
						<Segmented
							value={snapshot.cacheWarming}
							onChange={(mode) => void apply({ type: "cacheWarming", mode })}
							ariaLabelledBy={labelId}
							ariaDescribedBy={descriptionId}
							options={PI_CACHE_WARMING_MODES.map((value) => ({ value, label: t(`settings.cacheWarming_${value}`) }))}
						/>
					)}
				</SettingsFieldRow>
				<SettingsRow layout="toggle" label={t("settings.retry")} description={t("settings.retryDescription")}>
					<Switch
						checked={snapshot.retryEnabled}
						onCheckedChange={(enabled) => void apply({ type: "retry", enabled })}
						aria-label={t("settings.retry")}
					/>
				</SettingsRow>
				<NumberSettingRow
					label={t("settings.retryMaxRetries")}
					description={t("settings.retryMaxRetriesDescription")}
					value={snapshot.retryMaxRetries}
					min={PI_RETRY_MAX_RETRIES_MIN}
					max={PI_RETRY_MAX_RETRIES_MAX}
					onSave={(value) => apply({ type: "retryTuning", field: "maxRetries", value })}
				/>
				<NumberSettingRow
					label={t("settings.retryBaseDelayMs")}
					description={t("settings.retryBaseDelayMsDescription")}
					value={snapshot.retryBaseDelayMs}
					min={PI_RETRY_BASE_DELAY_MS_MIN}
					max={PI_RETRY_BASE_DELAY_MS_MAX}
					onSave={(value) => apply({ type: "retryTuning", field: "baseDelayMs", value })}
				/>
				<NumberSettingRow
					label={t("settings.retryMaxAgentDelayMs")}
					description={t("settings.retryMaxAgentDelayMsDescription")}
					value={snapshot.retryMaxAgentDelayMs}
					min={0}
					max={PI_RETRY_MAX_DELAY_MS_MAX}
					onSave={(value) => apply({ type: "retryTuning", field: "maxAgentDelayMs", value })}
				/>
				<SettingsRow
					layout="toggle"
					label={t("settings.blockImages")}
					description={t("settings.blockImagesDescription")}
				>
					<Switch
						checked={snapshot.blockImages}
						onCheckedChange={(blocked) => void apply({ type: "blockImages", blocked })}
						aria-label={t("settings.blockImages")}
					/>
				</SettingsRow>
				<SettingsRow
					layout="toggle"
					label={t("settings.imageAutoResize")}
					description={t("settings.imageAutoResizeDescription")}
				>
					<Switch
						checked={snapshot.imageAutoResize}
						onCheckedChange={(enabled) => void apply({ type: "imageAutoResize", enabled })}
						aria-label={t("settings.imageAutoResize")}
					/>
				</SettingsRow>
				<SettingsFieldRow group label={t("settings.steeringMode")}>
					{({ labelId, descriptionId }) => (
						<Segmented
							value={snapshot.steeringMode}
							onChange={(mode) => void apply({ type: "steeringMode", mode })}
							options={deliveryOptions}
							ariaLabelledBy={labelId}
							ariaDescribedBy={descriptionId}
						/>
					)}
				</SettingsFieldRow>
				<SettingsFieldRow group label={t("settings.followUpMode")}>
					{({ labelId, descriptionId }) => (
						<Segmented
							value={snapshot.followUpMode}
							onChange={(mode) => void apply({ type: "followUpMode", mode })}
							options={deliveryOptions}
							ariaLabelledBy={labelId}
							ariaDescribedBy={descriptionId}
						/>
					)}
				</SettingsFieldRow>
				<SettingsFieldRow
					group
					label={t("settings.defaultProjectTrust")}
					description={t("settings.defaultProjectTrustDescription")}
				>
					{({ labelId, descriptionId }) => (
						<Segmented
							value={snapshot.defaultProjectTrust}
							onChange={(trust) => void apply({ type: "defaultProjectTrust", trust })}
							options={projectTrustOptions}
							ariaLabelledBy={labelId}
							ariaDescribedBy={descriptionId}
						/>
					)}
				</SettingsFieldRow>
			</SettingsSection>

			<SettingsSection title={t("settings.piNetwork")}>
				<SettingsFieldRow label={t("settings.httpIdleTimeout")} description={t("settings.httpIdleTimeoutDescription")}>
					{({ controlId, labelId, descriptionId }) => (
						<Select
							value={String(snapshot.httpIdleTimeoutMs)}
							onValueChange={(value) => {
								if (value)
									void apply(() =>
										piSettingsUpdateSchema.parse({ type: "httpIdleTimeoutMs", timeoutMs: Number(value) }),
									);
							}}
						>
							<SelectTrigger id={controlId} aria-labelledby={labelId} aria-describedby={descriptionId} className="h-8">
								<SelectValue>{() => timeoutLabel(snapshot.httpIdleTimeoutMs)}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{HTTP_IDLE_TIMEOUT_CHOICES_MS.map((ms) => (
									<SelectItem key={ms} value={String(ms)}>
										{timeoutLabel(ms)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</SettingsFieldRow>
				<ProxyRow />
			</SettingsSection>

			<SettingsSection title={t("settings.piEnvironment")}>
				<ShellPathRow shellPath={snapshot.shellPath} onApply={apply} />
				<ShellCommandPrefixRow shellCommandPrefix={snapshot.shellCommandPrefix} onApply={apply} />
				<NpmCommandRow npmCommand={snapshot.npmCommand} onApply={apply} />
			</SettingsSection>

			<SettingsSection title={t("settings.piPrivacy")}>
				<SettingsRow
					layout="toggle"
					label={t("settings.installTelemetry")}
					description={t("settings.installTelemetryDescription")}
				>
					<Switch
						checked={snapshot.installTelemetry}
						onCheckedChange={(enabled) => void apply({ type: "installTelemetry", enabled })}
						aria-label={t("settings.installTelemetry")}
					/>
				</SettingsRow>
				<SettingsRow layout="toggle" label={t("settings.analytics")} description={t("settings.analyticsDescription")}>
					<Switch
						checked={snapshot.analytics}
						onCheckedChange={(enabled) => void apply({ type: "analytics", enabled })}
						aria-label={t("settings.analytics")}
					/>
				</SettingsRow>
			</SettingsSection>
		</SettingsPage>
	);
}

function ShellPathRow({
	shellPath,
	onApply,
}: {
	shellPath: string | null;
	onApply(update: PiSettingsUpdate): Promise<boolean>;
}) {
	const { t } = useTranslation();
	return (
		<TextSettingRow
			label={t("settings.shellPath")}
			description={t("settings.shellPathDescription")}
			value={shellPath ?? ""}
			onSave={(draft) => onApply({ type: "shellPath", path: draft.trim() === "" ? null : draft.trim() })}
		/>
	);
}
function ShellCommandPrefixRow({
	shellCommandPrefix,
	onApply,
}: {
	shellCommandPrefix: string | null;
	onApply(update: PiSettingsUpdate): Promise<boolean>;
}) {
	const { t } = useTranslation();
	return (
		<TextSettingRow
			label={t("settings.shellCommandPrefix")}
			description={t("settings.shellCommandPrefixDescription")}
			value={shellCommandPrefix ?? ""}
			placeholder="shopt -s expand_aliases"
			onSave={(draft) => onApply({ type: "shellCommandPrefix", prefix: draft.trim() === "" ? null : draft.trim() })}
		/>
	);
}
function NpmCommandRow({
	npmCommand,
	onApply,
}: {
	npmCommand: string | null;
	onApply(update: PiSettingsUpdate): Promise<boolean>;
}) {
	const { t } = useTranslation();
	return (
		<TextSettingRow
			label={t("settings.npmCommand")}
			description={t("settings.npmCommandDescription")}
			value={npmCommand ?? ""}
			placeholder="npm"
			onSave={(draft) => onApply({ type: "npmCommand", command: draft.trim() === "" ? null : draft.trim() })}
		/>
	);
}
