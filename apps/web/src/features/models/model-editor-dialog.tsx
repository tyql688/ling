import { MODEL_SAMPLING_PARAMS_LIMITS } from "@ling/contracts/model";

import { ModelPicker } from "@renderer/features/models/model-picker";

import { Badge } from "@renderer/components/ui/badge";

import { Button } from "@renderer/components/ui/button";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";

import { FeedbackNotice } from "@renderer/components/ui/feedback";

import { Input } from "@renderer/components/ui/input";

import { MultiSelectGroup } from "@renderer/components/ui/multi-select-group";

import { Switch } from "@renderer/components/ui/switch";

import { Textarea } from "@renderer/components/ui/textarea";

import { Image, RotateCcw, Type } from "lucide-react";

import { ModelConfigurationJson } from "./model-configuration-dialog";

import { useModelEditor, type CopyGroup, type ModelsModelEditorDialogProps } from "./use-model-editor";

export function ModelsModelEditorDialog(props: ModelsModelEditorDialogProps) {
	const {
		selectReference,
		clearReference,
		changeCopyGroups,
		resetInputTypes,
		changeInputTypes,
		fieldId,
		draft,
		fieldChange,
		submitting,
		loading,
		initial,
		invalidField,
		formId,
		onClose,
		submit,
		t,
		models,
		provider,
		reference,
		referenceError,
		retry,
		source,
		copyGroups,
		parsedOptions,
		selectedInputs,
		jsonDrafts,
		preview,
		error,
	} = useModelEditor(props);

	const field = (
		key: "id" | "name" | "contextWindow" | "maxTokens",
		label: string,
		hint: string,
		placeholder?: string,
	) => (
		<div className="flex min-w-0 flex-col gap-1.5">
			<label htmlFor={fieldId(key)} className="text-xs font-medium text-text-muted">
				{label}
			</label>
			<Input
				id={fieldId(key)}
				value={draft[key]}
				onChange={(event) => fieldChange(key, event.target.value)}
				disabled={
					submitting ||
					(loading && (key === "contextWindow" || key === "maxTokens")) ||
					(key === "id" && initial !== null)
				}
				placeholder={placeholder}
				inputMode={key === "contextWindow" || key === "maxTokens" ? "numeric" : "text"}
				className="h-11 font-mono sm:h-9"
				aria-invalid={invalidField === key || undefined}
				aria-describedby={`${fieldId(key)}-hint${invalidField === key ? ` ${formId}-error` : ""}`}
			/>
			<span id={`${fieldId(key)}-hint`} className="text-xs text-text-muted">
				{hint}
			</span>
		</div>
	);
	return (
		<Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
			<DialogContent
				size="medium"
				className="overflow-y-auto"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					document.getElementById(fieldId(initial ? "name" : "id"))?.focus();
				}}
			>
				<form
					className="flex min-w-0 flex-col gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<DialogHeader>
						<DialogTitle>{t(initial ? "models.editModelTitle" : "models.addModelTitle", { provider })}</DialogTitle>
						<p className="text-xs text-text-muted">{t("models.modelConnectionHint")}</p>
					</DialogHeader>
					{initial === null && (
						<div className="flex flex-col gap-2">
							<label id={`${formId}-reference`} className="text-xs font-medium text-text-muted">
								{t("models.referenceModel")}
							</label>
							<div className="flex min-w-0 gap-2">
								<ModelPicker
									options={models.map((model) => ({ ...model, provider, providerName: provider }))}
									selected={reference === null ? null : { provider, id: reference }}
									onSelect={selectReference}
									disabled={submitting}
									triggerAriaLabelledBy={`${formId}-reference`}
									triggerClassName="min-h-11 min-w-0 flex-1 rounded-control border border-border-subtle bg-input px-3 py-2 text-sm"
								>
									<span className="truncate">
										{reference === null
											? t("models.manualModel")
											: (models.find((model) => model.id === reference)?.name ?? reference)}
									</span>
								</ModelPicker>
								{reference !== null && (
									<Button type="button" variant="outline" disabled={submitting} onClick={clearReference}>
										{t("models.manualModel")}
									</Button>
								)}
							</div>
							{loading && (
								<p role="status" className="text-xs text-text-muted">
									{t("models.loadingConfiguration")}
								</p>
							)}
							{referenceError && (
								<FeedbackNotice
									tone="danger"
									action={
										<Button type="button" variant="outline" size="sm" onClick={retry}>
											{t("models.retry")}
										</Button>
									}
								>
									{referenceError}
								</FeedbackNotice>
							)}
							{source && !loading && !referenceError && (
								<details>
									<summary className="cursor-pointer py-2 text-xs text-text-muted">{t("models.copyScope")}</summary>
									<MultiSelectGroup
										aria-label={t("models.copyScope")}
										options={(Object.keys(copyGroups) as CopyGroup[]).map((group) => ({
											value: group,
											label: t(`models.copyGroup_${group}`),
										}))}
										value={(Object.keys(copyGroups) as CopyGroup[]).filter((group) => copyGroups[group])}
										disabled={submitting}
										onValueChange={changeCopyGroups}
									/>
									<p className="mt-2 text-xs text-text-muted">{t("models.referenceIndependentHint")}</p>
								</details>
							)}
						</div>
					)}
					{field("id", t("models.modelId"), t("models.modelIdHint"), "deepseek-v4.1-flash-expires-on-0910")}
					{field("name", t("models.modelName"), t("models.modelNameHint"))}
					<div className="flex min-w-0 flex-col gap-2.5">
						<div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
							<div className="flex min-w-0 items-center gap-2">
								<span id={`${formId}-input-label`} className="text-xs font-medium text-text-muted">
									{t("models.inputTypes")}
								</span>
								{parsedOptions !== null && parsedOptions.input === undefined && (
									<Badge>{t("models.sourceDefault")}</Badge>
								)}
							</div>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="gap-1.5 text-text-muted active:scale-100 pointer-coarse:min-h-11"
								disabled={submitting || loading || parsedOptions === null || parsedOptions.input === undefined}
								onClick={resetInputTypes}
							>
								<RotateCcw className="size-3" strokeWidth={1.5} aria-hidden="true" />
								{t("models.inputRestoreDefault")}
							</Button>
						</div>
						<MultiSelectGroup
							aria-labelledby={`${formId}-input-label`}
							aria-describedby={`${formId}-input-hint`}
							options={[
								{ value: "text", label: t("models.inputText"), icon: <Type strokeWidth={1.5} /> },
								{ value: "image", label: t("models.inputImage"), icon: <Image strokeWidth={1.5} /> },
							]}
							value={selectedInputs ?? []}
							disabled={submitting || loading || parsedOptions === null}
							onValueChange={changeInputTypes}
						/>
						<p id={`${formId}-input-hint`} className="text-xs text-text-muted">
							{t(parsedOptions === null ? "models.inputInvalidOptionsHint" : "models.inputTypesHint")}
						</p>
					</div>
					<details className="border-t border-border-subtle pt-3">
						<summary className="cursor-pointer py-2 text-sm">{t("models.modelParameters")}</summary>
						<div className="mt-3 flex flex-col gap-4">
							<div className="grid gap-3 sm:grid-cols-2">
								{field("contextWindow", t("models.contextWindowLabel"), t("models.modelLimitHint"), "128000")}
								{field("maxTokens", t("models.maxTokensLabel"), t("models.modelLimitHint"), "16384")}
							</div>
							<div className="flex min-h-11 items-center gap-2 text-sm">
								<Switch
									id={fieldId("reasoning")}
									checked={draft.reasoning}
									disabled={submitting || loading}
									onCheckedChange={(value) => fieldChange("reasoning", value)}
								/>
								<label htmlFor={fieldId("reasoning")}>{t("models.reasoningLabel")}</label>
							</div>
							{(["compat", "samplingParams", "options"] as const).map((key) => (
								<div key={key} className="flex flex-col gap-1.5">
									<label htmlFor={fieldId(key)} className="text-xs font-medium text-text-muted">
										{t(
											key === "options"
												? "models.modelOptions"
												: key === "compat"
													? "models.compatLabel"
													: "models.samplingParamsLabel",
										)}
									</label>
									<Textarea
										id={fieldId(key)}
										value={draft[key]}
										disabled={submitting || loading}
										onChange={(event) => fieldChange(key, event.target.value)}
										maxLength={MODEL_SAMPLING_PARAMS_LIMITS.maxBytes}
										className="min-h-28 font-mono text-xs"
										aria-invalid={jsonDrafts[key].error !== null || undefined}
										aria-describedby={`${fieldId(key)}-hint`}
									/>
									<p id={`${fieldId(key)}-hint`} className="text-xs text-text-muted">
										{jsonDrafts[key].error ??
											t(
												key === "options"
													? "models.modelOptionsHint"
													: key === "compat"
														? "models.compatHint"
														: "models.samplingParamsHint",
											)}
									</p>
								</div>
							))}
						</div>
					</details>
					<details className="border-t border-border-subtle pt-3">
						<summary className="cursor-pointer py-2 text-sm">{t("models.previewConfiguration")}</summary>
						{preview === null ? (
							<p className="text-xs text-danger">{t("models.fixConfigurationFirst")}</p>
						) : (
							<ModelConfigurationJson value={{ providers: { [provider]: { models: [preview] } } }} />
						)}
					</details>
					{error && (
						<FeedbackNotice tone="danger">
							<p id={`${formId}-error`}>{error}</p>
						</FeedbackNotice>
					)}
					<DialogFooter className="flex-wrap border-t border-border-subtle pt-4">
						<Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
							{t("models.cancel")}
						</Button>
						<Button type="submit" disabled={submitting || loading || referenceError !== null}>
							{submitting ? t("models.savingModel") : t(initial ? "models.saveKey" : "models.addModel")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
