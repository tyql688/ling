import {
	PI_COMPACTION_TOKEN_MAX,
	PI_COMPACTION_TOKEN_MIN,
	type PiSettingsSnapshot,
	type PiSettingsUpdate,
} from "@ling/contracts/pi-settings";
import { Button } from "@renderer/components/ui/button";
import { NumberSettingRow } from "@renderer/components/ui/number-setting-row";
import { Segmented } from "@renderer/components/ui/segmented";
import { SettingsFieldRow, SettingsRow } from "@renderer/components/ui/settings-list";
import { ModelPicker } from "@renderer/features/models/model-picker";
import type { ModelPickerOption } from "@renderer/features/models/model-picker-options";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function PiCompactionSettings({
	snapshot,
	models,
	apply,
}: {
	snapshot: PiSettingsSnapshot;
	models: readonly ModelPickerOption[];
	apply(update: PiSettingsUpdate): Promise<boolean>;
}) {
	const { t } = useTranslation();
	const [scope, setScope] = useState<"global" | "model">("global");
	const [model, setModel] = useState<ModelPickerOption | null>(null);
	const selected = scope === "model" ? model : null;
	const override = selected ? snapshot.compactionModelOverrides[`${selected.provider}/${selected.id}`] : undefined;
	const save = (field: "reserveTokens" | "keepRecentTokens", tokens: number) =>
		selected
			? apply({
					type: "compactionModel",
					provider: selected.provider,
					modelId: selected.id,
					override: { [field]: tokens },
				})
			: apply({ type: "compactionTokens", field, tokens });
	return (
		<>
			<SettingsFieldRow label={t("settings.compactionScope")} description={t("settings.compactionScopeDescription")}>
				{({ labelId, descriptionId }) => (
					<Segmented
						value={scope}
						onChange={setScope}
						ariaLabelledBy={labelId}
						ariaDescribedBy={descriptionId}
						options={[
							{ value: "global", label: t("settings.compactionAllModels") },
							{ value: "model", label: t("settings.compactionOneModel") },
						]}
					/>
				)}
			</SettingsFieldRow>
			{scope === "model" && (
				<SettingsFieldRow label={t("settings.compactionModel")}>
					{({ controlId, labelId, descriptionId }) => (
						<ModelPicker
							options={models}
							selected={model}
							defaultModel={
								snapshot.defaultProvider && snapshot.defaultModel
									? { provider: snapshot.defaultProvider, id: snapshot.defaultModel }
									: null
							}
							onSelect={setModel}
							triggerId={controlId}
							triggerAriaLabelledBy={labelId}
							triggerAriaDescribedBy={descriptionId}
							triggerClassName="h-8 max-w-56 rounded-control border border-border-subtle bg-surface px-2.5 text-sm text-text-primary hover:bg-surface-hover"
						>
							<span className="min-w-0 truncate">{model?.name ?? t("settings.compactionChooseModel")}</span>
						</ModelPicker>
					)}
				</SettingsFieldRow>
			)}
			{(scope === "global" || selected) && (
				<>
					<NumberSettingRow
						key={`${scope}:${selected?.provider}/${selected?.id}:reserve`}
						label={t("settings.compactionReserveTokens")}
						description={t("settings.compactionReserveTokensDescription")}
						value={override?.reserveTokens ?? snapshot.compactionReserveTokens}
						min={PI_COMPACTION_TOKEN_MIN}
						max={PI_COMPACTION_TOKEN_MAX}
						onSave={(tokens) => save("reserveTokens", tokens)}
					/>
					<NumberSettingRow
						key={`${scope}:${selected?.provider}/${selected?.id}:recent`}
						label={t("settings.compactionKeepRecentTokens")}
						description={t("settings.compactionKeepRecentTokensDescription")}
						value={override?.keepRecentTokens ?? snapshot.compactionKeepRecentTokens}
						min={PI_COMPACTION_TOKEN_MIN}
						max={PI_COMPACTION_TOKEN_MAX}
						onSave={(tokens) => save("keepRecentTokens", tokens)}
					/>
				</>
			)}
			{selected && override && (override.reserveTokens !== undefined || override.keepRecentTokens !== undefined) && (
				<SettingsRow label={t("settings.compactionResetDescription")}>
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							void apply({ type: "compactionModel", provider: selected.provider, modelId: selected.id, override: null })
						}
					>
						{t("settings.compactionReset")}
					</Button>
				</SettingsRow>
			)}
		</>
	);
}
