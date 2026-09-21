import type { ModelPickerOption } from "@renderer/features/models/model-picker-options";

import { useDomainApi } from "@renderer/lib/host-api-context";

import type { ModelInfo, ThinkingLevel } from "@ling/contracts/session";

import { useProjectModels } from "@renderer/features/models/use-project-models";

import { formatRequestError } from "@renderer/lib/errors";

import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "react-i18next";

import {
	resolveQuickStartDefaultModel,
	resolveQuickStartSelectedModel,
	resolveQuickStartThinkingLevel,
} from "./quick-start-default-model";
const EMPTY_PROJECT_MODELS: readonly ModelInfo[] = [];
/** Project-scoped model choices and shared Pi defaults refresh independently of the composer draft. */
export function useQuickStartModels(cwd: string | null) {
	const hostPiSettingsApi = useDomainApi("piSettings");
	const { t } = useTranslation();
	const [modelSelection, setModelSelection] = useState<{
		provider: string;
		id: string;
	} | null>(null);
	const [pickedThinkingLevel, setPickedThinkingLevel] = useState<ThinkingLevel | null>(null);
	const {
		models: projectModels,
		pendingCatalog,
		error: projectModelsError,
		retry: retryModels,
	} = useProjectModels(cwd);
	const [settingsAttempt, setSettingsAttempt] = useState(0);
	const [piSettingsError, setPiSettingsError] = useState<string | null>(null);
	const [piModelDefaults, setPiModelDefaults] = useState<{
		defaultProvider: string | null;
		defaultModel: string | null;
		defaultThinkingLevel: ThinkingLevel | null;
		enableSkillCommands: boolean;
	} | null>(null);
	useEffect(() => {
		let cancelled = false;
		let revision = 0;
		const refresh = () => {
			const request = ++revision;
			void hostPiSettingsApi
				.get()
				.then((snapshot) => {
					if (cancelled || request !== revision) return;
					setPiSettingsError(null);
					setPiModelDefaults({
						defaultProvider: snapshot.defaultProvider,
						defaultModel: snapshot.defaultModel,
						defaultThinkingLevel: snapshot.defaultThinkingLevel,
						enableSkillCommands: snapshot.enableSkillCommands,
					});
				})
				.catch((cause: unknown) => {
					if (!cancelled && request === revision) setPiSettingsError(formatRequestError(cause));
				});
		};
		refresh();
		const unsubscribe = hostPiSettingsApi.onChanged(refresh);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [hostPiSettingsApi, settingsAttempt]);
	// The project runtime already filters this snapshot to models with effective auth.
	// Unlike the profile settings catalog, it also includes project/package providers.
	const modelOptions = projectModels ?? EMPTY_PROJECT_MODELS;
	const resolvedDefault = useMemo(
		() => resolveQuickStartDefaultModel(modelOptions, piModelDefaults),
		[modelOptions, piModelDefaults],
	);
	const model = resolveQuickStartSelectedModel(modelSelection, modelOptions);
	const effectiveModel = model ?? resolvedDefault;
	// Pi resolves the thinking default independently, then clamps it to the final model.
	const availableThinkingLevels = effectiveModel?.availableThinkingLevels ?? [];
	const effectiveThinkingLevel = resolveQuickStartThinkingLevel(
		pickedThinkingLevel === null ? piModelDefaults : { defaultThinkingLevel: pickedThinkingLevel },
		availableThinkingLevels,
	);
	// Keep the last resolved controls in place while validating the next folder. Submission
	// still uses only the current catalog above; failures clear the pending snapshot.
	const displayModel = pendingCatalog
		? (resolveQuickStartSelectedModel(modelSelection, pendingCatalog.models) ??
			resolveQuickStartDefaultModel(pendingCatalog.models, piModelDefaults))
		: effectiveModel;
	const displayThinkingLevels = displayModel?.availableThinkingLevels ?? [];
	const displayThinkingLevel = resolveQuickStartThinkingLevel(
		pickedThinkingLevel === null ? piModelDefaults : { defaultThinkingLevel: pickedThinkingLevel },
		displayThinkingLevels,
	);
	const modelPillLabel = displayModel?.name ?? t("session.defaultModel");
	const selectModel = (option: ModelPickerOption) => {
		const selected = modelOptions.find(
			(candidate) => candidate.provider === option.provider && candidate.id === option.id,
		);
		if (selected && cwd !== null) {
			setModelSelection({ provider: selected.provider, id: selected.id });
		}
	};
	const selectThinking = (level: ThinkingLevel) => {
		if (projectModels !== null && cwd !== null) setPickedThinkingLevel(level);
	};

	return {
		displayModel,
		displayThinkingLevels,
		displayThinkingLevel,
		model,
		modelOptions,
		pickedThinkingLevel,
		modelPillLabel,
		effectiveThinkingLevel,
		selectModel,
		selectThinking,
		setupError: projectModelsError ?? piSettingsError,
		modelsLoaded: projectModels !== null && piModelDefaults !== null,
		skillCommandsEnabled: piModelDefaults?.enableSkillCommands === true,
		retrySetup() {
			retryModels();
			setSettingsAttempt((current) => current + 1);
		},
	};
}
