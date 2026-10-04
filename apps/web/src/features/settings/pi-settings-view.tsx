import { PiCompactionSettings } from "./pi-compaction-settings";
import { ChoiceButton } from "@renderer/components/ui/choice-button";
import {
	HTTP_IDLE_TIMEOUT_CHOICES_MS,
	PI_BUILT_IN_TOOL_NAMES,
	PI_CACHE_WARMING_MODES,
	PI_CODEMODE_INLINE_BUDGET_MAX,
	PI_RETRY_MAX_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MIN,
	PI_RETRY_MAX_RETRIES_MAX,
	PI_RETRY_MAX_RETRIES_MIN,
	type DefaultProjectTrust,
	type MessageDeliveryMode,
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
import { isWindows } from "@renderer/lib/platform";
import { Settings2 } from "lucide-react";
import { atom, useAtom } from "jotai";
import { useMemo, useState, type ReactNode } from "react";
import type { OpenProjectInfo } from "@ling/contracts/project";
import { PiConfigurationEditor } from "./pi-configuration-editor";
import { usePiSettings, useProxySetting } from "./use-pi-settings";
import { useTranslation } from "react-i18next";
import { TextSettingRow } from "@renderer/components/ui/text-setting-row";

const piSettingsLocationAtom = atom<{ scope: string; mode: "common" | "configuration" }>({
	scope: "global",
	mode: "common",
});

/** Proxy absence is Pi's automatic network mode; failed reads stay distinct. */
function ProxyRow() {
	const { t } = useTranslation();
	const { stored, error, load, save } = useProxySetting();
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

/** Edits Pi's global settings.json for agent behavior and refreshes open projects' SettingsManager instances. Terminal themes, image-cell settings and cursor options are edited in Pi's CLI. */
export function PiSettingsView({ projects }: { projects: OpenProjectInfo[] }) {
	const { t } = useTranslation();
	const [{ scope, mode }, setLocation] = useAtom(piSettingsLocationAtom);
	const setScope = (scope: string) => setLocation((current) => ({ ...current, scope }));
	const setMode = (mode: "common" | "configuration") => setLocation((current) => ({ ...current, mode }));
	const [dirty, setDirty] = useState(false);
	const cwd = projects.find((project) => project.cwd === scope)?.cwd ?? null;
	const controls = (
		<div className="flex flex-wrap gap-2">
			<Select
				disabled={dirty}
				value={cwd ?? "global"}
				onValueChange={(value) => {
					setScope(value);
					if (value !== "global") setMode("configuration");
				}}
			>
				<SelectTrigger className="w-full sm:w-64" aria-label={t("mcp.scope")}>
					<SelectValue>
						{cwd === null
							? t("mcp.global")
							: t("mcp.project", { name: projects.find((project) => project.cwd === cwd)?.name ?? cwd })}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="global">{t("mcp.global")}</SelectItem>
					{projects.map((project) => (
						<SelectItem key={project.cwd} value={project.cwd}>
							{t("mcp.project", { name: project.name })}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{cwd === null && (
				<Segmented
					disabled={dirty}
					value={mode}
					onChange={setMode}
					options={[
						{ value: "common", label: t("piConfiguration.common") },
						{ value: "configuration", label: t("piConfiguration.complete") },
					]}
				/>
			)}
		</div>
	);
	return mode === "common" && cwd === null ? (
		<PiCommonSettings controls={controls} />
	) : (
		<SettingsPage title={t("settings.pi")}>
			{controls}
			<PiConfigurationEditor key={cwd ?? "global"} cwd={cwd} onDirtyChange={setDirty} />
		</SettingsPage>
	);
}

function PiCommonSettings({ controls }: { controls: ReactNode }) {
	const { t } = useTranslation();
	const { snapshot, pending, settingsError, recoveryStatus, repairing, load, repairHttpIdleTimeout, apply } =
		usePiSettings();
	const { providers, error: providersError, refresh: refreshProviders } = useProviders();
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

	if (!snapshot) {
		return (
			<SettingsPage title={t("settings.pi")}>
				{controls}
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
	const toolsPending = [...pending].some((key) => key === "defaultTools" || key.startsWith("defaultTools:"));

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
			{controls}
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
							pending={pending.has("defaultModel")}
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
							<SelectTrigger
								pending={pending.has("thinkingLevel")}
								id={controlId}
								aria-labelledby={labelId}
								aria-describedby={descriptionId}
								className="h-8"
							>
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
							<div className="grid grid-cols-1 gap-2 @min-[20rem]/default-tools:grid-cols-2 @min-[30rem]/default-tools:grid-cols-3 @min-[40rem]/default-tools:grid-cols-4">
								{[...new Set([...PI_BUILT_IN_TOOL_NAMES, ...snapshot.defaultTools])]
									.filter((tool) => tool !== "powershell" || isWindows)
									.map((tool) => {
										const selected = snapshot.defaultTools.includes(tool);
										return (
											<ChoiceButton
												key={tool}
												type="button"
												selected={selected}
												pending={pending.has("defaultTools") || pending.has(`defaultTools:${tool}`)}
												onClick={() =>
													void apply(
														(current) => ({
															type: "defaultTools",
															tools: current.defaultTools.includes(tool)
																? current.defaultTools.filter((name) => name !== tool)
																: [...current.defaultTools, tool],
														}),
														`defaultTools:${tool}`,
													)
												}
												className="w-full justify-between font-mono text-xs"
											>
												<span className="min-w-0 break-all text-start">{tool}</span>
											</ChoiceButton>
										);
									})}
							</div>
							<Button
								className="mt-2"
								variant="ghost"
								size="sm"
								disabled={!snapshot.defaultToolsConfigured || toolsPending}
								pending={pending.has("defaultTools")}
								onClick={() => void apply({ type: "defaultTools", tools: null })}
							>
								{t("settings.defaultToolsReset")}
							</Button>
						</div>
					)}
				</SettingsFieldRow>
			</SettingsSection>

			<SettingsSection title="Codemode" description={t("settings.codemodeDescription")}>
				<SettingsFieldRow label={t("settings.codemodeMode")} description={t("settings.codemodeModeDescription")}>
					{({ labelId, descriptionId }) => (
						<Segmented
							value={snapshot.codemode.mode}
							pending={pending.has("codemode:mode")}
							onChange={(mode) => void apply({ type: "codemode", settings: { mode } })}
							ariaLabelledBy={labelId}
							ariaDescribedBy={descriptionId}
							options={(["on", "only"] as const).map((value) => ({
								value,
								label: t(`settings.codemodeMode_${value}`),
							}))}
						/>
					)}
				</SettingsFieldRow>
				<NumberSettingRow
					label={t("settings.codemodeInlineBudget")}
					description={t("settings.codemodeInlineBudgetDescription")}
					value={snapshot.codemode.inlineBudget}
					min={0}
					max={PI_CODEMODE_INLINE_BUDGET_MAX}
					onSave={(inlineBudget) => apply({ type: "codemode", settings: { inlineBudget } })}
				/>
			</SettingsSection>

			<SettingsSection title={t("settings.piBehavior")}>
				<SettingsRow layout="toggle" label={t("settings.compaction")} description={t("settings.compactionDescription")}>
					<Switch
						checked={snapshot.compactionEnabled}
						pending={pending.has("compaction")}
						onCheckedChange={(enabled) => void apply({ type: "compaction", enabled })}
						aria-label={t("settings.compaction")}
					/>
				</SettingsRow>
				<PiCompactionSettings snapshot={snapshot} models={modelOptions} apply={apply} />
				<SettingsFieldRow label={t("settings.cacheWarming")} description={t("settings.cacheWarmingDescription")}>
					{({ labelId, descriptionId }) => (
						<Segmented
							value={snapshot.cacheWarming}
							pending={pending.has("cacheWarming")}
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
						pending={pending.has("retry")}
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
						pending={pending.has("blockImages")}
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
						pending={pending.has("imageAutoResize")}
						onCheckedChange={(enabled) => void apply({ type: "imageAutoResize", enabled })}
						aria-label={t("settings.imageAutoResize")}
					/>
				</SettingsRow>
				<SettingsFieldRow group label={t("settings.steeringMode")}>
					{({ labelId, descriptionId }) => (
						<Segmented
							value={snapshot.steeringMode}
							pending={pending.has("steeringMode")}
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
							pending={pending.has("followUpMode")}
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
							pending={pending.has("defaultProjectTrust")}
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
							<SelectTrigger
								pending={pending.has("httpIdleTimeoutMs")}
								id={controlId}
								aria-labelledby={labelId}
								aria-describedby={descriptionId}
								className="h-8"
							>
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
						pending={pending.has("installTelemetry")}
						onCheckedChange={(enabled) => void apply({ type: "installTelemetry", enabled })}
						aria-label={t("settings.installTelemetry")}
					/>
				</SettingsRow>
				<SettingsRow layout="toggle" label={t("settings.analytics")} description={t("settings.analyticsDescription")}>
					<Switch
						checked={snapshot.analytics}
						pending={pending.has("analytics")}
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
