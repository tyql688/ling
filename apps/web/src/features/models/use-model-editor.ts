import { useDomainApi } from "@renderer/lib/host-api-context";

import { boundedJsonObjectValidationError, type BoundedJsonObject } from "@ling/contracts/bounded-json";

import {
	MODEL_SAMPLING_PARAMS_LIMITS,
	modelCompatValidationError,
	modelOptionsSchema,
	type ProviderModelDefinition,
	type ProviderModelInfo,
} from "@ling/contracts/model";

import { errorMessage } from "@ling/contracts/ling-error";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { parseModelConfigObjectDraft } from "./models-json-draft";

import { useModelConfiguration } from "./use-model-configuration";

interface ModelDraft {
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	samplingParams: string;
	compat: string;
	options: string;
}

export type CopyGroup = "capabilities" | "compat" | "sampling" | "cost";

const initialCopyGroups: Record<CopyGroup, boolean> = { capabilities: true, compat: true, sampling: true, cost: false };

const inputTypes = ["text", "image"] as const;

/** Pi gives custom definitions text input when the field is omitted. */
const defaultInputTypes = ["text"] as const;

const objectText = (value: object | null) =>
	value === null || Object.keys(value).length === 0 ? "" : JSON.stringify(value, null, 2);

function createModelDraft(initial: ProviderModelInfo | null): ModelDraft {
	const definition = initial?.definition;
	return {
		id: initial?.id ?? "",
		name: definition?.name ?? "",
		contextWindow: definition?.contextWindow == null ? "" : String(definition.contextWindow),
		maxTokens: definition?.maxTokens == null ? "" : String(definition.maxTokens),
		reasoning: definition?.reasoning ?? false,
		samplingParams: objectText(definition?.samplingParams ?? null),
		compat: objectText(definition?.compat ?? null),
		options: objectText(definition?.options ?? null),
	};
}

function applyReferenceGroup(
	draft: ModelDraft,
	source: ProviderModelDefinition,
	group: CopyGroup,
	enabled: boolean,
): ModelDraft {
	if (group === "compat") return { ...draft, compat: enabled ? objectText(source.compat) : "" };
	if (group === "sampling") return { ...draft, samplingParams: enabled ? objectText(source.samplingParams) : "" };
	// Empty advanced settings intentionally delegate every portable field to Pi.
	const options = modelOptionsSchema.parse(draft.options.trim() === "" ? {} : JSON.parse(draft.options));
	if (group === "cost") {
		delete options.cost;
		if (enabled && source.options.cost !== undefined) options.cost = structuredClone(source.options.cost);
		return { ...draft, options: objectText(options) };
	}
	delete options.api;
	delete options.input;
	delete options.thinkingLevelMap;
	if (enabled) {
		const capabilities = structuredClone(source.options);
		delete capabilities.cost;
		Object.assign(options, structuredClone(capabilities));
	}
	return {
		...draft,
		options: objectText(options),
		contextWindow: enabled && source.contextWindow !== null ? String(source.contextWindow) : "",
		maxTokens: enabled && source.maxTokens !== null ? String(source.maxTokens) : "",
		reasoning: enabled && source.reasoning,
	};
}
export type ModelsModelEditorDialogProps = {
	provider: string;
	models: readonly ProviderModelInfo[];
	initial: ProviderModelInfo | null;
	referenceId: string | null;
	onClose: () => void;
};

/** Owns the form's asynchronous work, recovery state and submission intent. */
export function useModelEditor({ provider, models, initial, referenceId, onClose }: ModelsModelEditorDialogProps) {
	const hostModelsApi = useDomainApi("models");

	const { t } = useTranslation();
	const formId = useId();
	const [draft, setDraft] = useState(() => createModelDraft(initial));
	const [reference, setReference] = useState(referenceId);
	const [copyGroups, setCopyGroups] = useState(initialCopyGroups);
	const [appliedReference, setAppliedReference] = useState<string | null>(null);
	const [source, setSource] = useState<ProviderModelDefinition | null>(null);
	const { configuration, loading, error: referenceError, retry } = useModelConfiguration(provider, reference, null);
	const [error, setError] = useState<string | null>(null);
	const [invalidField, setInvalidField] = useState<keyof ModelDraft | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (!configuration || reference === appliedReference) return;
		setSource(configuration.template);
		setDraft((previous) => {
			let next = { ...createModelDraft(null), id: previous.id, name: previous.name };
			for (const group of Object.keys(copyGroups) as CopyGroup[])
				next = applyReferenceGroup(next, configuration.template, group, copyGroups[group]);
			return next;
		});
		setAppliedReference(reference);
	}, [configuration, reference, appliedReference, copyGroups]);
	const jsonDrafts = useMemo(() => {
		const parse = (value: string, validate: (value: unknown) => string | null) =>
			parseModelConfigObjectDraft(value, validate, t("models.configurationInvalidJson"), (issue) =>
				t("models.samplingParamsInvalid", { error: issue }),
			);
		return {
			samplingParams: parse(draft.samplingParams, (value) =>
				boundedJsonObjectValidationError(value, MODEL_SAMPLING_PARAMS_LIMITS),
			),
			compat: parse(draft.compat, modelCompatValidationError),
			options: parse(draft.options, (value) => {
				const parsed = modelOptionsSchema.safeParse(value);
				return parsed.success
					? null
					: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
			}),
		};
	}, [draft.samplingParams, draft.compat, draft.options, t]);
	// The JSON draft is the single owner. Invalid JSON must stay visible rather
	// than making the input selector appear to have reverted to Pi defaults.
	const parsedOptions =
		jsonDrafts.options.error === null ? modelOptionsSchema.parse(jsonDrafts.options.value ?? {}) : null;
	const selectedInputs = parsedOptions === null ? null : (parsedOptions.input ?? defaultInputTypes);
	const fieldId = (field: keyof ModelDraft) => `${formId}-${field}`;
	const fieldChange = (field: keyof ModelDraft, value: string | boolean) => {
		setDraft((previous) => ({ ...previous, [field]: value }));
		if (invalidField === field) {
			setInvalidField(null);
			setError(null);
		}
	};
	const parseLimit = (field: "contextWindow" | "maxTokens"): number | null => {
		if (draft[field].trim() === "") return null;
		const value = Number(draft[field]);
		if (!Number.isSafeInteger(value) || value <= 0) {
			setInvalidField(field);
			throw new Error(t("models.invalidNumber", { value: draft[field] }));
		}
		return value;
	};
	const submit = async () => {
		setError(null);
		setInvalidField(null);
		try {
			if (loading || referenceError !== null) return;
			if (!draft.id.trim()) {
				setInvalidField("id");
				throw new Error(t("models.modelIdRequired"));
			}
			if (initial === null && models.some((model) => model.id === draft.id.trim())) {
				setInvalidField("id");
				throw new Error(t("models.duplicateModelId"));
			}
			for (const field of ["samplingParams", "compat", "options"] as const) {
				if (jsonDrafts[field].error !== null) {
					setInvalidField(field);
					throw new Error(jsonDrafts[field].error);
				}
			}
			const fields = {
				provider,
				name: draft.name.trim() || null,
				contextWindow: parseLimit("contextWindow"),
				maxTokens: parseLimit("maxTokens"),
				reasoning: draft.reasoning,
				samplingParams: jsonDrafts.samplingParams.value,
				compat: jsonDrafts.compat.value,
				options: modelOptionsSchema.parse(jsonDrafts.options.value ?? {}),
			};
			setSubmitting(true);
			if (initial) await hostModelsApi.updateModel({ ...fields, modelId: initial.id });
			else await hostModelsApi.addModel({ ...fields, id: draft.id.trim() });
			if (mounted.current) onClose();
		} catch (cause) {
			if (mounted.current) {
				setError(errorMessage(cause));
				setSubmitting(false);
			}
		}
	};
	useEffect(() => {
		if (invalidField === null) return;
		const element = document.getElementById(`${formId}-${invalidField}`);
		const details = element?.closest("details");
		if (details) details.open = true;
		element?.focus();
	}, [invalidField, formId]);
	const preview: BoundedJsonObject | null =
		Object.values(jsonDrafts).some((value) => value.error !== null) ||
		["contextWindow", "maxTokens"].some((key) => {
			const value = draft[key as "contextWindow" | "maxTokens"];
			return value.trim() !== "" && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0);
		})
			? null
			: {
					id: draft.id.trim(),
					...(draft.name.trim() ? { name: draft.name.trim() } : {}),
					...(draft.contextWindow.trim() ? { contextWindow: Number(draft.contextWindow) } : {}),
					...(draft.maxTokens.trim() ? { maxTokens: Number(draft.maxTokens) } : {}),
					...(draft.reasoning ? { reasoning: true } : {}),
					...(jsonDrafts.samplingParams.value === null ? {} : { samplingParams: jsonDrafts.samplingParams.value }),
					...(jsonDrafts.compat.value === null ? {} : { compat: jsonDrafts.compat.value }),
					...jsonDrafts.options.value,
				};
	const selectReference = (model: { id: string }) => {
		setReference(model.id);
		setAppliedReference(null);
		setError(null);
	};
	const clearReference = () => {
		setReference(null);
		setAppliedReference(null);
		setSource(null);
		setDraft((previous) => ({ ...createModelDraft(null), id: previous.id, name: previous.name }));
	};
	const changeCopyGroups = (groups: readonly string[]) => {
		if (source === null) return;
		try {
			let next = draft;
			const nextGroups = { ...copyGroups };
			for (const group of Object.keys(copyGroups) as CopyGroup[]) {
				const enabled = groups.includes(group);
				if (enabled === copyGroups[group]) continue;
				next = applyReferenceGroup(next, source, group, enabled);
				nextGroups[group] = enabled;
			}
			setDraft(next);
			setCopyGroups(nextGroups);
			setError(null);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const resetInputTypes = () => {
		if (parsedOptions === null) return;
		const options = { ...parsedOptions };
		delete options.input;
		fieldChange("options", objectText(options));
	};
	const changeInputTypes = (values: readonly string[]) => {
		if (parsedOptions === null) return;
		const input = inputTypes.filter((type) => values.includes(type));
		fieldChange("options", objectText({ ...parsedOptions, input }));
	};
	return {
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
	};
}
