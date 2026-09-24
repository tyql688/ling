import type { VoiceConfiguration, VoiceOverview } from "@ling/contracts/voice";
import type { PiResourceReloadSummary } from "@ling/contracts/session";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { ResourceReloadFeedback } from "@renderer/components/resource-reload-feedback";
import { BuiltinFeatureDocumentation } from "@renderer/features/companions/builtin-feature-documentation";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { VoiceError } from "./voice-error";
import { preferredVoiceModels, voiceLanguageForModel } from "./voice-models";
import { voiceShortcut, voiceSettingsShortcut } from "./voice-shortcuts";

export function VoiceSettings({
	cwd,
	onClose,
	returnFocusRef,
}: {
	cwd: string;
	onClose(): void;
	returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
	const { t, i18n } = useTranslation();
	const api = useDomainApi("voice");
	const [overview, setOverview] = useState<VoiceOverview | null>(null);
	const [configuration, setConfiguration] = useState<VoiceConfiguration>({
		modelId: "",
		language: "auto",
		chineseOutput: "simplified",
	});
	const [error, setError] = useState<{ cause: unknown } | null>(null);
	const [loadRevision, setLoadRevision] = useState(0);
	const [busy, setBusy] = useState(false);
	const [reload, setReload] = useState<PiResourceReloadSummary | null>(null);
	const operation = useRef<string | null>(null);
	const alive = useRef(false);
	useEffect(() => {
		alive.current = true;
		let active = true;
		void api.read({ cwd }).then(
			(value) => {
				if (!active) return;
				setOverview(value);
				if (value.configuration) setConfiguration(value.configuration);
			},
			(cause: unknown) => {
				if (active) setError({ cause });
			},
		);
		return () => {
			active = false;
			alive.current = false;
			if (operation.current)
				void api
					.cancel({ operationId: operation.current })
					.catch((cause: unknown) => console.error("Voice cancellation failed", cause));
		};
	}, [api, cwd, loadRevision]);
	const selected = overview?.models.find((model) => model.id === configuration.modelId);
	const installed = selected?.downloaded || overview?.configuration?.modelId === selected?.id;
	const applied =
		overview?.configuration?.modelId === configuration.modelId &&
		overview.configuration.language === configuration.language &&
		overview.configuration.chineseOutput === configuration.chineseOutput;
	const languageName = (code: string) => {
		if (code === "zh") return t("voice.mandarin");
		if (code === "yue") return t("voice.cantonese");
		try {
			return new Intl.DisplayNames([i18n.language], { type: "language" }).of(code) ?? code;
		} catch {
			return code;
		}
	};
	const supportsChinese =
		selected?.languages.some((code) => /^(zh|yue)(-|$)/.test(code)) &&
		(configuration.language === "auto" || /^(zh|yue)(-|$)/.test(configuration.language));
	async function save() {
		if (!selected || operation.current) return;
		const operationId = crypto.randomUUID();
		operation.current = operationId;
		setBusy(true);
		setError(null);
		setReload(null);
		try {
			const result = await api.configure({ cwd, operationId, configuration, download: !installed });
			if (!alive.current || operation.current !== operationId) return;
			setReload(result);
			const value = await api.read({ cwd });
			if (alive.current && operation.current === operationId) setOverview(value);
		} catch (cause) {
			if (alive.current && operation.current === operationId) setError({ cause });
		} finally {
			if (alive.current && operation.current === operationId) {
				operation.current = null;
				setBusy(false);
			}
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				size="small"
				className="flex flex-col"
				onCloseAutoFocus={(event) => {
					// A context-menu item unmounts before the dialog closes; restore its voice button instead.
					const target = returnFocusRef?.current;
					if (target?.isConnected && !target.disabled) {
						event.preventDefault();
						target.focus({ preventScroll: true });
					}
				}}
			>
				<DialogCloseButton aria-label={t("session.cancel")} />
				<DialogHeader className="shrink-0">
					<div className="flex flex-wrap items-center gap-2 pr-6">
						<DialogTitle>{t("voice.settings")}</DialogTitle>
						<BuiltinFeatureDocumentation id="voice" label={t("voice.title")} />
					</div>
					<DialogDescription>{t("voice.description")}</DialogDescription>
				</DialogHeader>
				<div className="mt-4 flex min-h-0 flex-col gap-4 overflow-y-auto">
					{error && (
						<FeedbackNotice
							tone="danger"
							action={
								!overview && (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											setError(null);
											setLoadRevision((revision) => revision + 1);
										}}
									>
										{t("common.retry")}
									</Button>
								)
							}
						>
							<VoiceError error={error.cause} />
						</FeedbackNotice>
					)}
					{overview?.warning && (
						<FeedbackNotice tone="warning">
							<VoiceError error={overview.warning} />
						</FeedbackNotice>
					)}
					{!overview && !error && (
						<p role="status" className="text-sm text-text-muted">
							{t("voice.loading")}
						</p>
					)}
					{overview && (
						<>
							<div className="flex flex-col gap-2">
								<span className="text-sm font-medium">{t("voice.model")}</span>
								<Select
									value={configuration.modelId}
									disabled={busy}
									onValueChange={(modelId) => {
										const model = overview.models.find((item) => item.id === modelId);
										if (model)
											setConfiguration((current) => ({
												...current,
												modelId,
												language: voiceLanguageForModel(model, current.language, i18n.language),
											}));
									}}
								>
									<SelectTrigger className="w-full" aria-label={t("voice.model")}>
										<SelectValue>{selected?.name ?? t("voice.chooseModel")}</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{preferredVoiceModels(overview.models, i18n.language).map((model) => (
											<SelectItem key={model.id} value={model.id}>
												{model.name} · {Math.round(model.bytes / 1024 / 1024)} MB
												{model.downloaded ? ` · ${t("voice.downloaded")}` : ""}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-xs leading-relaxed text-text-muted">{t("voice.modelLanguageHint")}</p>
							</div>
							{selected && (
								<>
									<details className="text-xs leading-relaxed text-text-muted">
										<summary className="cursor-pointer rounded-control focus-visible:bg-surface-hover">
											{t("voice.supportedLanguages", { count: selected.languages.length })}
										</summary>
										<p className="mt-1 max-h-24 overflow-auto">
											{new Intl.ListFormat(i18n.language).format(selected.languages.map(languageName))}
										</p>
									</details>
									<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
										<span className="text-sm">{t("voice.language")}</span>
										<Select
											value={configuration.language}
											disabled={busy}
											onValueChange={(language) => setConfiguration((current) => ({ ...current, language }))}
										>
											<SelectTrigger className="w-full sm:max-w-52 sm:w-auto" aria-label={t("voice.language")}>
												<SelectValue>
													{configuration.language === "auto"
														? t("voice.autoLanguage")
														: languageName(configuration.language)}
												</SelectValue>
											</SelectTrigger>
											<SelectContent>
												{selected.autoDetect && <SelectItem value="auto">{t("voice.autoLanguage")}</SelectItem>}
												{selected.languages.map((language) => (
													<SelectItem key={language} value={language}>
														{languageName(language)}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									{supportsChinese && (
										<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
											<span className="text-sm">{t("voice.chineseOutput")}</span>
											<Select
												value={configuration.chineseOutput}
												disabled={busy}
												onValueChange={(value) =>
													setConfiguration((current) => ({
														...current,
														chineseOutput: value as VoiceConfiguration["chineseOutput"],
													}))
												}
											>
												<SelectTrigger className="w-full sm:max-w-52 sm:w-auto" aria-label={t("voice.chineseOutput")}>
													<SelectValue>{t(`voice.${configuration.chineseOutput}`)}</SelectValue>
												</SelectTrigger>
												<SelectContent>
													{(["simplified", "traditional-taiwan", "traditional-hong-kong"] as const).map((value) => (
														<SelectItem key={value} value={value}>
															{t(`voice.${value}`)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									)}
									{!installed && (
										<p className="text-xs text-text-muted">
											{t("voice.downloadNotice", { size: Math.round(selected.bytes / 1024 / 1024) })}
										</p>
									)}
								</>
							)}
							<div className="flex justify-end gap-2">
								{!applied && (
									<Button variant="ghost" onClick={onClose}>
										{t(busy ? "voice.cancelOperation" : "session.cancel")}
									</Button>
								)}
								<Button disabled={busy || !selected} onClick={() => (applied ? onClose() : void save())}>
									{busy
										? t(installed ? "voice.saving" : "voice.downloading")
										: applied
											? t("voice.done")
											: t(installed ? "voice.useModel" : "voice.downloadModel")}
								</Button>
							</div>
						</>
					)}
					{reload && <ResourceReloadFeedback summary={reload} />}
					<p className="text-xs leading-relaxed text-text-muted">
						{t("voice.shortcutHint", { shortcut: voiceShortcut, settingsShortcut: voiceSettingsShortcut })}
					</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}
