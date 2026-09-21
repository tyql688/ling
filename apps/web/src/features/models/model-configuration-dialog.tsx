import type { BoundedJson, BoundedJsonObject } from "@ling/contracts/bounded-json";
import type { ModelConfiguration, ProviderModelInfo, ProviderSummary } from "@ling/contracts/model";
import { errorMessage } from "@ling/contracts/ling-error";
import { Button } from "@renderer/components/ui/button";
import { ChoiceButton } from "@renderer/components/ui/choice-button";
import { Dialog, DialogCloseButton, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelConfiguration } from "./use-model-configuration";

/** Shared JSON presentation keeps configuration copying observable without retaining clipboard timers. */
export function ModelConfigurationJson({ value }: { value: BoundedJsonObject }) {
	const { t } = useTranslation();
	const text = JSON.stringify(value, null, 2);
	const [copied, setCopied] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const copy = async () => {
		try {
			if (!navigator.clipboard) throw new Error(t("markdown.clipboardUnavailable"));
			await navigator.clipboard.writeText(text);
			if (active.current) {
				setCopied(text);
				setError(null);
			}
		} catch (cause) {
			if (active.current) setError(errorMessage(cause));
		}
	};
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex justify-end">
				<Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
					{copied === text ? t("markdown.copied") : t("models.copyConfiguration")}
				</Button>
			</div>
			{error && <FeedbackNotice tone="danger">{error}</FeedbackNotice>}
			<pre className="skin-surface whitespace-pre-wrap break-all rounded-panel border border-reading-surface-border bg-code-block p-3 font-mono text-xs leading-relaxed shadow-reading-surface">
				{text}
			</pre>
		</div>
	);
}

function fieldOrigin(configuration: ModelConfiguration, field: string): string {
	if (!Object.hasOwn(configuration.effective, field)) return "models.notSet";
	// Pi applies modelOverrides after both custom definitions and extension models.
	if (
		field !== "api" &&
		field !== "baseUrl" &&
		configuration.overrides !== null &&
		Object.hasOwn(configuration.overrides, field)
	)
		return "models.sourceOverride";
	if (configuration.configured !== null && Object.hasOwn(configuration.configured, field)) return "models.sourceCustom";
	if (configuration.source === "extension") return "models.sourceExtension";
	if (Object.hasOwn(configuration.providerDefaults, field)) return "models.sourceProvider";
	return configuration.source === "custom" ? "models.sourceDefault" : "models.sourceBuiltin";
}

function displayValue(value: BoundedJson | undefined, fallback: string): string {
	if (value === undefined || value === null) return fallback;
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function ModelConfigurationDialog({
	provider,
	model,
	onClose,
	onDerive,
	onEdit,
}: {
	provider: ProviderSummary;
	model: ProviderModelInfo;
	onClose: () => void;
	onDerive: () => void;
	onEdit: () => void;
}) {
	const { t } = useTranslation();
	const { configuration, error, loading, retry } = useModelConfiguration(provider.id, model.id, provider.projectCwd);
	const [mode, setMode] = useState<"effective" | "configured">("effective");
	const rows = [
		["api", "models.apiProtocol"],
		["baseUrl", "models.baseUrl"],
		["contextWindow", "models.configurationContextWindow"],
		["maxTokens", "models.configurationMaxTokens"],
		["input", "models.inputTypes"],
		["reasoning", "models.reasoningLabel"],
		["thinkingLevelMap", "models.thinkingMap"],
		["samplingParams", "models.configurationSamplingParams"],
		["compat", "models.configurationCompat"],
	] as const;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent size="medium" className="overflow-y-auto">
				<DialogCloseButton aria-label={t("models.cancel")} />
				<div className="flex min-w-0 flex-col gap-5">
					<DialogHeader>
						<DialogTitle className="break-words pr-8">{model.name}</DialogTitle>
						<p className="break-all font-mono text-xs text-text-muted">
							{provider.id}/{model.id}
						</p>
					</DialogHeader>
					{loading && (
						<p role="status" className="text-sm text-text-muted">
							{t("models.loadingConfiguration")}
						</p>
					)}
					{error && (
						<FeedbackNotice
							tone="danger"
							action={
								<Button type="button" variant="outline" size="sm" onClick={retry}>
									{t("models.retry")}
								</Button>
							}
						>
							{error}
						</FeedbackNotice>
					)}
					{configuration && (
						<>
							<div className="flex flex-wrap justify-end gap-2">
								{!provider.projectExtension && model.definition !== null && (
									<Button type="button" variant="outline" onClick={onEdit}>
										{t("models.editModel")}
									</Button>
								)}
								{!provider.projectExtension && (
									<Button type="button" onClick={onDerive}>
										{t("models.addFromModel")}
									</Button>
								)}
							</div>
							<p className="text-xs text-text-muted">{t("models.configurationHint")}</p>
							<dl className="divide-y divide-border-subtle">
								{rows.map(([field, label]) => (
									<div
										key={field}
										className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
									>
										<dt className="text-text-muted">{t(label)}</dt>
										<dd className="min-w-0 break-all font-mono text-xs leading-relaxed">
											{displayValue(configuration.effective[field], t("models.notSet"))}
										</dd>
										<dd className="col-start-2 text-xs text-text-muted sm:col-start-auto">
											{t(fieldOrigin(configuration, field))}
										</dd>
									</div>
								))}
							</dl>
							<div className="flex flex-wrap gap-2">
								{(["effective", "configured"] as const).map((value) => (
									<ChoiceButton key={value} selected={mode === value} onClick={() => setMode(value)}>
										<span className="min-w-0 break-words text-start">
											{t(value === "effective" ? "models.effectiveConfiguration" : "models.savedConfiguration")}
										</span>
									</ChoiceButton>
								))}
							</div>
							{mode === "configured" && configuration.configured === null && configuration.overrides === null && (
								<p className="text-xs text-text-muted">{t("models.noCustomConfiguration")}</p>
							)}
							<ModelConfigurationJson
								value={
									mode === "effective"
										? configuration.effective
										: {
												providers: {
													[provider.id]: {
														...configuration.providerDefaults,
														...(configuration.configured === null ? {} : { models: [configuration.configured] }),
														...(configuration.overrides === null
															? {}
															: { modelOverrides: { [model.id]: configuration.overrides } }),
													},
												},
											}
								}
							/>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
