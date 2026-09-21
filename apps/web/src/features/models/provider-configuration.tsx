import {
	CUSTOM_PROVIDER_APIS,
	MODEL_COMPAT_LIMITS,
	modelCompatValidationError,
	type CustomProviderApi,
	type ProviderSummary,
} from "@ling/contracts/model";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { SettingSaveStatus } from "@renderer/components/ui/setting-save-status";
import { TextSettingRow } from "@renderer/components/ui/text-setting-row";
import { Textarea } from "@renderer/components/ui/textarea";
import { useSettingDraft } from "@renderer/hooks/use-setting-draft";
import { isShortcutModifier } from "@renderer/lib/platform";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { parseModelConfigObjectDraft } from "./models-json-draft";
import type { ProviderUpdateFields } from "./use-provider-detail";

/** Custom endpoint preferences save independently; credentials retain their explicit connect action. */
export function ProviderConfiguration({
	provider,
	busy,
	save,
}: {
	provider: ProviderSummary;
	busy: boolean;
	save(patch: Partial<ProviderUpdateFields>): Promise<boolean>;
}) {
	const { t } = useTranslation();
	const protocolId = useId(),
		compatibilityId = useId();
	const parseCompatibility = (text: string) =>
		parseModelConfigObjectDraft(text, modelCompatValidationError, t("models.compatInvalidJson"), (issue) =>
			t("models.compatInvalid", { error: issue }),
		);
	const field = useSettingDraft(
		provider.compat === null ? "" : JSON.stringify(provider.compat, null, 2),
		async (text) => {
			const parsed = parseCompatibility(text);
			if (parsed.error !== null) return false;
			return save({ compat: parsed.value });
		},
		(text) => parseCompatibility(text).error === null,
	);
	const compat = parseCompatibility(field.draft);
	if (!provider.custom) return null;
	return (
		<div className="divide-y divide-border-subtle">
			<TextSettingRow
				label={t("models.providerName")}
				description=""
				value={provider.name ?? ""}
				placeholder={provider.id}
				disabled={busy}
				onSave={(value) => save({ name: value.trim() === "" ? null : value.trim() })}
			/>
			<TextSettingRow
				label={t("models.baseUrl")}
				description=""
				value={provider.baseUrl ?? ""}
				placeholder={t("models.baseUrlPlaceholder")}
				disabled={busy}
				validate={(value) => value.trim() !== ""}
				onSave={(value) => save({ baseUrl: value.trim() })}
			/>
			<div className="flex items-center justify-between gap-4 py-4">
				<span id={protocolId} className="text-sm">
					{t("models.apiProtocol")}
				</span>
				<Select
					value={provider.api ?? ""}
					onValueChange={(next) => {
						if (next && next !== provider.api) void save({ api: next as CustomProviderApi });
					}}
				>
					<SelectTrigger aria-labelledby={protocolId} disabled={busy} className="w-56 font-mono">
						<SelectValue>{() => provider.api ?? "—"}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{CUSTOM_PROVIDER_APIS.map((value) => (
							<SelectItem key={value} value={value}>
								{value}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="flex flex-col gap-2 py-4">
				<label htmlFor={compatibilityId} className="text-sm">
					{t("models.providerCompatLabel")}
				</label>
				<Textarea
					id={compatibilityId}
					value={field.draft}
					disabled={busy || field.state.status === "saving"}
					maxLength={MODEL_COMPAT_LIMITS.maxBytes}
					aria-invalid={!field.valid}
					className="min-h-28 font-mono text-xs"
					onChange={(event) => field.change(event.target.value)}
					onBlur={() => void field.commit()}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Enter" && isShortcutModifier(event)) {
							event.preventDefault();
							void field.commit();
						} else if (event.key === "Escape") {
							event.stopPropagation();
							field.reset();
						}
					}}
				/>
				<span className="text-xs text-text-muted">{t("models.providerCompatHint")}</span>
				{compat.error && <FeedbackNotice tone="danger">{compat.error}</FeedbackNotice>}
				<SettingSaveStatus state={field.state} retry={() => void field.commit()} />
			</div>
		</div>
	);
}
