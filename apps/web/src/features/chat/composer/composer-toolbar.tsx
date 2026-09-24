import type { ModelInfo, ModelState, ThinkingLevel } from "@ling/contracts/session";
import { ModelPicker } from "@renderer/features/models/model-picker";
import { ProviderGlyph } from "@renderer/features/models/provider-glyph";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { ThinkingLevelSelect } from "@renderer/features/chat/composer/thinking-level-select";
import type { ContextUsage } from "@renderer/features/usage/workspace-session-usage";
import { basenameFromPath } from "@renderer/lib/format-path";
import type { FollowUpBehavior } from "@renderer/lib/preferences/composer";
import { cn } from "@renderer/lib/utils";
import {
	ArrowUp,
	Brain,
	ChartColumn,
	CircleAlert,
	Clock3,
	LoaderCircle,
	Plus,
	SlidersHorizontal,
	Square,
	Zap,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { ModelPickerOption } from "@renderer/features/models/model-picker-options";
import { AccessModeControl } from "@renderer/features/pi-adapters/permission-system/access-mode-control";
import { TodoProgress } from "@renderer/features/pi-adapters/todo/todo-progress";
import { BackgroundTasksProgress } from "@renderer/features/background-tasks/background-tasks-progress";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import { useTranslation } from "react-i18next";
import type { ComposerPendingAction } from "./use-composer-core";
import { VoiceInput } from "@renderer/features/pi-adapters/voice/voice-input";

interface ComposerToolbarProps {
	projectPath: string;
	sessionRef?: SessionRef;
	modelState: ModelState | null;
	modelStateError: string | null;
	currentModel: ModelInfo | null;
	contextUsage: ContextUsage | null;
	followUpBehavior: FollowUpBehavior;
	busy: boolean;
	queuedEdit: boolean;
	hasSendableContent: boolean;
	pendingAction: ComposerPendingAction;
	onAttachFiles: (files: FileList) => void;
	usageOpen: boolean;
	onOpenUsage: () => void;
	onModelSelect: (provider: string, modelId: string) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onFollowUpBehaviorChange: (behavior: FollowUpBehavior) => void;
	onSaveQueuedEdit: () => void;
	onAbort: () => void;
	onSubmit: () => void;
	onVoiceTranscript(text: string): boolean;
}

/** Feature controls shared by every composer: access mode for the project, progress badges for a session. */
export function ComposerFeatureControls({
	projectPath,
	sessionRef,
}: {
	projectPath: string;
	sessionRef?: SessionRef | undefined;
}) {
	return (
		<>
			<AccessModeControl cwd={projectPath} />
			{sessionRef && <TodoProgress sessionRef={sessionRef} />}
			{sessionRef && <BackgroundTasksProgress sessionRef={sessionRef} />}
		</>
	);
}

export function ComposerToolbarFrame({
	leading,
	features,
	children,
	actions,
	onAttachFiles,
}: {
	leading?: ReactNode;
	features?: ReactNode;
	children: ReactNode;
	actions: ReactNode;
	onAttachFiles(files: FileList): void;
}) {
	const { t } = useTranslation();
	const fileInputRef = useRef<HTMLInputElement>(null);
	return (
		<div className="flex min-h-8 min-w-0 items-end gap-2 @min-[36rem]/composer:items-center">
			<div className="-m-1 flex min-w-0 flex-1 flex-wrap items-center gap-1 p-1 @min-[36rem]/composer:flex-nowrap @min-[36rem]/composer:overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(event) => {
						if (event.target.files) onAttachFiles(event.target.files);
						event.target.value = "";
					}}
				/>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon"
								onClick={() => fileInputRef.current?.click()}
								aria-label={t("session.attach")}
								className="size-7 shrink-0 text-text-muted hover:text-text-primary"
							/>
						}
					>
						<Plus className="size-4" aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent>{t("session.attach")}</TooltipContent>
				</Tooltip>
				{leading}
				{features}
				{children}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-1.5">{actions}</div>
		</div>
	);
}

export function ComposerModelControls({
	options,
	selected,
	defaultModel,
	ownerKey,
	modelLabel,
	thinkingLevel,
	thinkingLevels,
	modelDisabled,
	thinkingDisabled,
	onModelSelect,
	onThinkingLevelChange,
	projectPath,
	additionalSettings,
}: {
	options: readonly ModelPickerOption[];
	selected: Pick<ModelPickerOption, "provider" | "id" | "name"> | null;
	defaultModel?: Pick<ModelPickerOption, "provider" | "id"> | null;
	ownerKey?: string;
	modelLabel?: string;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: readonly ThinkingLevel[];
	modelDisabled: boolean;
	thinkingDisabled: boolean;
	onModelSelect(model: ModelPickerOption): void;
	onThinkingLevelChange(level: ThinkingLevel): void;
	projectPath: string | null;
	additionalSettings?: { label: string; control: ReactNode };
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const model = (
		<ModelPicker
			options={options}
			selected={selected}
			defaultModel={defaultModel ?? null}
			ownerKey={ownerKey ?? projectPath ?? ""}
			placement="top-start"
			onSelect={onModelSelect}
			disabled={modelDisabled}
			triggerClassName="h-7 max-w-36 shrink-0 rounded-control border border-transparent bg-transparent px-1.5 text-xs font-normal leading-5 text-text-muted hover:bg-surface-hover hover:text-text-primary disabled:opacity-100 @min-[40rem]/composer:max-w-48"
		>
			<ProviderGlyph provider={selected?.provider ?? ""} size={14} className="shrink-0" />
			<span className="min-w-0 truncate">{modelLabel ?? selected?.name ?? t("session.defaultModel")}</span>
		</ModelPicker>
	);
	const thinking = (compact: boolean) => (
		<ThinkingLevelSelect
			value={thinkingLevel}
			levels={thinkingLevels}
			onChange={onThinkingLevelChange}
			disabled={thinkingDisabled}
			triggerClassName={
				compact
					? "h-8"
					: "h-7 max-w-28 shrink-0 gap-1 rounded-control border-transparent bg-transparent px-1.5 text-xs font-normal leading-5 text-text-muted hover:bg-surface-hover hover:text-text-primary disabled:opacity-100 [&_svg]:size-3"
			}
			icon={<Brain className="size-3.5 shrink-0" aria-hidden="true" />}
		/>
	);
	return (
		<>
			{model}
			{(thinkingLevels.length > 1 || additionalSettings) && (
				<Dialog open={open} onOpenChange={setOpen}>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setOpen(true)}
									aria-label={t("session.sessionSettings")}
									className="size-7 shrink-0 text-text-muted @min-[36rem]/composer:hidden"
								/>
							}
						>
							<SlidersHorizontal className="size-3.5" aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent>{t("session.sessionSettings")}</TooltipContent>
					</Tooltip>
					<DialogContent size="small">
						<DialogCloseButton aria-label={t("session.cancel")} />
						<DialogHeader>
							<DialogTitle>{t("session.sessionSettings")}</DialogTitle>
							<DialogDescription>
								{t(additionalSettings ? "session.sessionSettingsDescription" : "session.modelSettingsDescription")}
							</DialogDescription>
						</DialogHeader>
						<div className="mt-4 divide-y divide-border-subtle overflow-hidden rounded-panel border border-border-subtle">
							{projectPath && (
								<div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
									<span className="text-xs text-text-muted">{t("project.title")}</span>
									<span className="min-w-0 truncate text-xs font-medium" title={projectPath}>
										{basenameFromPath(projectPath)}
									</span>
								</div>
							)}
							{thinkingLevels.length > 1 && (
								<div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
									<span className="text-xs text-text-muted">{t("session.thinkingLevelLabel")}</span>
									{thinking(true)}
								</div>
							)}
							{additionalSettings && (
								<div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
									<span className="text-xs text-text-muted">{additionalSettings.label}</span>
									{additionalSettings.control}
								</div>
							)}
						</div>
					</DialogContent>
				</Dialog>
			)}
			<div className="hidden min-w-0 items-center gap-1 @min-[36rem]/composer:flex">
				{thinkingLevels.length > 1 && thinking(false)}
				{additionalSettings?.control}
			</div>
		</>
	);
}

export function ComposerActionButton({
	pending,
	stop = false,
	label,
	disabled,
	onClick,
}: {
	pending: boolean;
	stop?: boolean;
	label: string;
	disabled: boolean;
	onClick(): void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						size="icon"
						onClick={onClick}
						disabled={disabled}
						aria-label={label}
						className="size-8 shrink-0 rounded-full bg-text-primary text-[var(--color-scene-surface)] shadow-none hover:bg-text-primary/90 focus-visible:bg-text-primary/90"
					/>
				}
			>
				{pending ? (
					<span className="ling-spin" aria-hidden="true">
						<LoaderCircle className="size-4" />
					</span>
				) : stop ? (
					<Square className="size-3.5 fill-current" aria-hidden="true" />
				) : (
					<ArrowUp className="size-4" aria-hidden="true" />
				)}
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function PrimaryAction({
	busy,
	queuedEdit,
	hasSendableContent,
	pendingAction,
	followUpBehavior,
	onSaveQueuedEdit,
	onAbort,
	onSubmit,
}: Pick<
	ComposerToolbarProps,
	| "busy"
	| "queuedEdit"
	| "hasSendableContent"
	| "pendingAction"
	| "followUpBehavior"
	| "onSaveQueuedEdit"
	| "onAbort"
	| "onSubmit"
>) {
	const { t } = useTranslation();
	const pending = pendingAction !== null;
	const action = queuedEdit ? "save" : busy && !hasSendableContent ? "stop" : "send";
	const label =
		pendingAction === "save"
			? t("session.saving")
			: pendingAction === "stop"
				? t("session.stopping")
				: pendingAction === "send"
					? t("session.sending")
					: action === "save"
						? t("session.queuedEditSave")
						: action === "stop"
							? t("session.stop")
							: busy
								? t(`session.followUpMode_${followUpBehavior}`)
								: t("session.send");
	const onClick = action === "save" ? onSaveQueuedEdit : action === "stop" ? onAbort : onSubmit;

	return (
		<ComposerActionButton
			pending={pending}
			stop={action === "stop"}
			label={label}
			onClick={onClick}
			disabled={pending || (action !== "stop" && !hasSendableContent)}
		/>
	);
}

export function ComposerToolbar({
	projectPath,
	sessionRef,
	modelState,
	modelStateError,
	currentModel,
	contextUsage,
	followUpBehavior,
	busy,
	queuedEdit,
	hasSendableContent,
	pendingAction,
	onAttachFiles,
	usageOpen,
	onOpenUsage,
	onModelSelect,
	onThinkingLevelChange,
	onFollowUpBehaviorChange,
	onSaveQueuedEdit,
	onAbort,
	onSubmit,
	onVoiceTranscript,
}: ComposerToolbarProps) {
	const { t } = useTranslation();
	const ModeIcon = followUpBehavior === "queue" ? Clock3 : Zap;
	const followUp = (
		<Select
			value={followUpBehavior}
			onValueChange={(value) => onFollowUpBehaviorChange(value as FollowUpBehavior)}
			disabled={pendingAction !== null}
		>
			<SelectTrigger
				aria-label={t("session.followUpMode")}
				title={t("session.followUpModeDescription")}
				className="h-7 max-w-28 shrink-0 gap-1 rounded-control border-transparent bg-transparent px-1.5 text-xs font-normal text-text-muted hover:bg-surface-hover hover:text-text-primary [&_svg]:size-3"
			>
				<ModeIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<SelectValue>{() => t(`session.followUpMode_${followUpBehavior}`)}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="queue">{t("session.followUpMode_queue")}</SelectItem>
				<SelectItem value="steer">{t("session.followUpMode_steer")}</SelectItem>
			</SelectContent>
		</Select>
	);
	return (
		<ComposerToolbarFrame
			onAttachFiles={onAttachFiles}
			features={<ComposerFeatureControls projectPath={projectPath} sessionRef={sessionRef} />}
			actions={
				<>
					{sessionRef && (
						<VoiceInput
							sessionRef={sessionRef}
							disabled={queuedEdit || pendingAction !== null}
							onTranscript={onVoiceTranscript}
						/>
					)}
					{modelStateError && (
						<span
							role="status"
							aria-label={modelStateError}
							title={modelStateError}
							className="flex size-7 items-center justify-center text-danger"
						>
							<CircleAlert className="size-3.5" aria-hidden="true" />
						</span>
					)}
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									id="session-usage-trigger"
									type="button"
									onClick={onOpenUsage}
									aria-label={t("session.usageOpen")}
									aria-controls="session-usage-dialog"
									aria-expanded={usageOpen}
									aria-haspopup="dialog"
									className={cn(
										"inline-flex h-7 shrink-0 items-center gap-1 rounded-control px-1.5 text-xs tabular-nums text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary",
										usageOpen && "bg-surface-hover text-text-primary",
										contextUsage &&
											(contextUsage.percent >= 90
												? "text-context-high"
												: contextUsage.percent >= 70
													? "text-context-medium"
													: "text-text-muted"),
									)}
								/>
							}
						>
							<ChartColumn className="size-3.5 shrink-0" aria-hidden="true" />
							{contextUsage && <span>{contextUsage.percent}%</span>}
						</TooltipTrigger>
						<TooltipContent>
							{contextUsage
								? t("session.usageOpenWithContext", { percent: contextUsage.percent })
								: t("session.usageOpen")}
						</TooltipContent>
					</Tooltip>
					<PrimaryAction
						busy={busy}
						queuedEdit={queuedEdit}
						hasSendableContent={hasSendableContent}
						pendingAction={pendingAction}
						followUpBehavior={followUpBehavior}
						onSaveQueuedEdit={onSaveQueuedEdit}
						onAbort={onAbort}
						onSubmit={onSubmit}
					/>
				</>
			}
		>
			<ComposerModelControls
				ownerKey={sessionRef ? sessionKey(sessionRef) : projectPath}
				options={modelState?.models ?? []}
				selected={currentModel}
				thinkingLevel={modelState?.thinkingLevel ?? "off"}
				thinkingLevels={modelState?.availableThinkingLevels ?? []}
				modelDisabled={busy || pendingAction !== null || !modelState}
				thinkingDisabled={pendingAction !== null || !modelState}
				projectPath={projectPath}
				onModelSelect={(model) => onModelSelect(model.provider, model.id)}
				onThinkingLevelChange={onThinkingLevelChange}
				additionalSettings={{ label: t("session.followUpMode"), control: followUp }}
			/>
		</ComposerToolbarFrame>
	);
}
