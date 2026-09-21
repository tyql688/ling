import { useDomainApi } from "@renderer/lib/host-api-context";
import type { CustomProviderApi } from "@ling/contracts/model";
import { CUSTOM_PROVIDER_APIS, MODEL_COMPAT_LIMITS, modelCompatValidationError } from "@ling/contracts/model";
import { errorMessage } from "@ling/contracts/ling-error";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { Textarea } from "@renderer/components/ui/textarea";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseModelConfigObjectDraft } from "./models-json-draft";

/** Lowercase slug suggestion from the display name; Chinese names produce "" (user types an id). */
function suggestProviderId(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Writes Pi's models.json structure plus the optional auth.json credential. */
export function ModelsAddProviderDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (id: string) => void;
}) {
	const hostModelsApi = useDomainApi("models");

	const { t } = useTranslation();
	const idInputId = useId();
	const nameInputId = useId();
	const baseUrlInputId = useId();
	const apiProtocolLabelId = useId();
	const compatInputId = useId();
	const apiKeyInputId = useId();
	const [name, setName] = useState("");
	const [id, setId] = useState("");
	const [idTouched, setIdTouched] = useState(false);
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState<CustomProviderApi>("openai-completions");
	const [compatDraft, setCompatDraft] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [probing, setProbing] = useState(false);
	const [probeText, setProbeText] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

	const compat = useMemo(
		() =>
			parseModelConfigObjectDraft(compatDraft, modelCompatValidationError, t("models.compatInvalidJson"), (issue) =>
				t("models.compatInvalid", { error: issue }),
			),
		[compatDraft, t],
	);
	const canSubmit = id.trim() !== "" && baseUrl.trim() !== "" && compat.error === null && !submitting && !probing;

	const probe = async () => {
		setProbing(true);
		setProbeText(null);
		try {
			const result = await hostModelsApi.probeProvider({
				baseUrl: baseUrl.trim(),
				apiKey: apiKey.trim() === "" ? null : apiKey.trim(),
			});
			if (result.ok) {
				setProbeText({
					tone: "ok",
					text:
						result.modelCount === null ? t("models.probeOkNoCount") : t("models.probeOk", { count: result.modelCount }),
				});
			} else {
				const detail =
					result.reason === "auth"
						? t("models.probeAuth", { status: result.status })
						: result.reason === "timeout"
							? t("models.probeTimeout")
							: result.reason === "http"
								? t("models.probeHttp", { status: result.status })
								: t("models.probeUnreachable");
				// A failed probe is advisory: /models is optional on compatible endpoints.
				setProbeText({ tone: "warn", text: `${detail} ${t("models.probeAdvisory")}` });
			}
		} catch (cause) {
			setProbeText({ tone: "warn", text: errorMessage(cause) });
		} finally {
			setProbing(false);
		}
	};

	const submit = async () => {
		setSubmitting(true);
		try {
			if (compat.error) throw new Error(compat.error);
			await hostModelsApi.addProvider({
				id: id.trim(),
				name: name.trim() === "" ? null : name.trim(),
				baseUrl: baseUrl.trim(),
				api,
				apiKey: apiKey.trim() === "" ? null : apiKey.trim(),
				compat: compat.value,
			});
			onCreated(id.trim());
			onClose();
		} catch (cause) {
			setError(errorMessage(cause));
			setSubmitting(false);
		}
	};

	return (
		<Dialog open onOpenChange={(next) => !next && !submitting && onClose()}>
			<DialogContent className="overflow-y-auto">
				<div className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{t("models.addProviderTitle")}</DialogTitle>
					</DialogHeader>

					<div className="flex flex-col gap-1.5">
						<label htmlFor={idInputId} className="text-xs font-medium text-text-muted">
							{t("models.providerId")}
						</label>
						<Input
							id={idInputId}
							// eslint-disable-next-line jsx-a11y/no-autofocus -- modal dialogs own focus on open; the desktop shell has no page behind them to steal it from
							autoFocus
							value={id}
							disabled={submitting}
							placeholder="my-relay"
							className="h-11 font-mono sm:h-9"
							onChange={(event) => {
								setIdTouched(true);
								setId(event.target.value);
							}}
						/>
						<span className="text-xs text-text-muted">{t("models.providerIdHint")}</span>
					</div>

					<div className="flex flex-col gap-1.5">
						<label htmlFor={nameInputId} className="text-xs font-medium text-text-muted">
							{t("models.providerName")}
						</label>
						<Input
							id={nameInputId}
							value={name}
							disabled={submitting}
							placeholder={t("models.providerNamePlaceholder")}
							onChange={(event) => {
								setName(event.target.value);
								if (!idTouched) setId(suggestProviderId(event.target.value));
							}}
							className="h-11 sm:h-9"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label htmlFor={baseUrlInputId} className="text-xs font-medium text-text-muted">
							{t("models.baseUrl")}
						</label>
						<Input
							id={baseUrlInputId}
							value={baseUrl}
							disabled={submitting}
							placeholder={t("models.baseUrlPlaceholder")}
							className="h-11 font-mono sm:h-9"
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<span id={apiProtocolLabelId} className="text-xs font-medium text-text-muted">
							{t("models.apiProtocol")}
						</span>
						<Select value={api} onValueChange={(next) => next && setApi(next as CustomProviderApi)}>
							<SelectTrigger
								aria-labelledby={apiProtocolLabelId}
								disabled={submitting}
								className="h-11 w-full font-mono sm:h-9"
							>
								<SelectValue>{() => api}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{CUSTOM_PROVIDER_APIS.map((value) => (
									<SelectItem key={value} value={value} className="font-mono">
										{value}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1.5">
						<label htmlFor={compatInputId} className="text-xs font-medium text-text-muted">
							{t("models.providerCompatLabel")}
						</label>
						<Textarea
							id={compatInputId}
							value={compatDraft}
							disabled={submitting}
							placeholder={'{\n  "supportsDeveloperRole": false\n}'}
							maxLength={MODEL_COMPAT_LIMITS.maxBytes}
							className="min-h-28 font-mono text-xs"
							onChange={(event) => setCompatDraft(event.target.value)}
						/>
						<span className="text-xs text-text-muted">{t("models.providerCompatHint")}</span>
						{compat.error && (
							<FeedbackNotice tone="danger" className="text-xs">
								{compat.error}
							</FeedbackNotice>
						)}
					</div>

					<div className="flex flex-col gap-1.5">
						<label htmlFor={apiKeyInputId} className="text-xs font-medium text-text-muted">
							{t("models.apiKeyOptionalLabel")}
						</label>
						<Input
							id={apiKeyInputId}
							type="password"
							value={apiKey}
							disabled={submitting}
							placeholder={t("models.apiKeyPlaceholder")}
							className="h-11 font-mono sm:h-9"
							onChange={(event) => setApiKey(event.target.value)}
						/>
					</div>

					{error && (
						<FeedbackNotice tone="danger" className="text-xs">
							{error}
						</FeedbackNotice>
					)}

					{probeText && (
						<FeedbackNotice tone={probeText.tone === "ok" ? "success" : "warning"} className="text-xs">
							{probeText.text}
						</FeedbackNotice>
					)}

					<DialogFooter>
						<Button
							className="min-h-11 sm:min-h-9 sm:mr-auto"
							variant="outline"
							disabled={baseUrl.trim() === "" || probing || submitting}
							onClick={() => void probe()}
						>
							{probing ? t("models.probing") : t("models.probe")}
						</Button>
						<Button className="min-h-11 sm:min-h-9" variant="outline" disabled={submitting} onClick={onClose}>
							{t("models.cancel")}
						</Button>
						<Button className="min-h-11 sm:min-h-9" disabled={!canSubmit} onClick={() => void submit()}>
							{t("models.create")}
						</Button>
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}
