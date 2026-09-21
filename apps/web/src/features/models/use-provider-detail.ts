import type { BoundedJsonObject } from "@ling/contracts/bounded-json";

import {
	CUSTOM_PROVIDER_APIS,
	type CustomProviderApi,
	type ProviderModelInfo,
	type ProviderSummary,
} from "@ling/contracts/model";

import { createRequestFence, type RequestFence } from "@renderer/lib/request-fence";
import { formatCompactNumber } from "@renderer/lib/format-number";

import { useEffect, useId, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

export interface ProviderUpdateFields {
	name: string | null;
	baseUrl: string;
	api: CustomProviderApi | null;
	compat: BoundedJsonObject | null;
}

export interface ModelsProviderDetailProps {
	provider: ProviderSummary;
	busy: boolean;
	onBack: () => void;
	onGetApiKey: () => Promise<string | null>;
	onSaveKey: (key: string) => Promise<boolean>;
	onRemoveAuth: () => void;
	onLogin: (method: "api_key" | "oauth") => void;
	onAddModel: () => void;
	onEditModel: (model: ProviderModelInfo) => void;
	onViewModel: (model: ProviderModelInfo) => void;
	onDeriveModel: (model: ProviderModelInfo) => void;
	onRemoveModel: (modelId: string) => void;
	onRemoveProvider: () => void;
	onUpdateProvider: (fields: ProviderUpdateFields) => Promise<boolean>;
}

/** Owns the form's asynchronous work, recovery state and submission intent. */
export function useProviderDetail({
	provider,
	busy,
	onBack,
	onGetApiKey,
	onSaveKey,
	onRemoveAuth,
	onLogin,
	onAddModel,
	onEditModel,
	onViewModel,
	onDeriveModel,
	onRemoveModel,
	onRemoveProvider,
	onUpdateProvider,
}: ModelsProviderDetailProps) {
	const { t, i18n } = useTranslation();
	const detailTitleId = useId();
	const modelListTitleId = useId();
	const modelSearchId = useId();
	const [modelQuery, setModelQuery] = useState("");
	const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase();
	const visibleModels = provider.models.filter((model) =>
		`${model.name} ${model.id}`.toLocaleLowerCase().includes(normalizedModelQuery),
	);

	// Saved credentials cross IPC only after an explicit reveal action. Keep the revealed
	// value separate so looking at a key never makes the replacement draft dirty.
	const [keyDraft, setKeyDraft] = useState("");
	const [revealedKey, setRevealedKey] = useState<{ provider: ProviderSummary; key: string } | null>(null);
	const [keyVisibilityOwner, setKeyVisibilityOwner] = useState<ProviderSummary | null>(null);
	const [keyRevealOwner, setKeyRevealOwner] = useState<ProviderSummary | null>(null);
	const revealFenceRef = useRef<RequestFence<ProviderSummary> | null>(null);
	revealFenceRef.current ??= createRequestFence<ProviderSummary>();
	const revealFence = revealFenceRef.current;
	const currentProviderRef = useRef(provider);
	if (currentProviderRef.current !== provider) {
		currentProviderRef.current = provider;
		revealFence.invalidate();
	}
	const activeRevealedKey = revealedKey?.provider === provider ? revealedKey.key : null;
	const showKey = keyVisibilityOwner === provider;
	const revealingKey = keyRevealOwner === provider;
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [confirmRemoveProvider, setConfirmRemoveProvider] = useState(false);
	const storedBaseUrl = provider.baseUrl === null ? "" : provider.baseUrl;
	const storedName = provider.name ?? "";

	useEffect(() => {
		currentProviderRef.current = provider;
		revealFence.invalidate();
		setRevealedKey(null);
		setKeyVisibilityOwner(null);
		setKeyRevealOwner(null);
	}, [provider, revealFence]);
	useEffect(() => () => revealFence.invalidate(), [revealFence]);
	const keyDirty = keyDraft.trim() !== "";

	const currentApi: CustomProviderApi | null = CUSTOM_PROVIDER_APIS.includes(provider.api as CustomProviderApi)
		? (provider.api as CustomProviderApi)
		: null;

	/** Every edit sends the full editable state; `patch` overrides the touched field. */
	const pushUpdate = (patch: Partial<ProviderUpdateFields>) => {
		return onUpdateProvider({
			name: patch.name !== undefined ? patch.name : storedName === "" ? null : storedName,
			baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : storedBaseUrl,
			api: patch.api !== undefined ? patch.api : currentApi,
			compat: patch.compat !== undefined ? patch.compat : provider.compat,
		});
	};

	const saveKey = async () => {
		const submittedKey = keyDraft.trim();
		const saved = await onSaveKey(submittedKey);
		if (!saved) return;
		// Do not discard a newer draft typed while the save request was in flight.
		setKeyDraft((current) => (current.trim() === submittedKey ? "" : current));
		revealFence.invalidate();
		setRevealedKey(null);
		setKeyVisibilityOwner(null);
		setKeyRevealOwner(null);
	};

	const toggleKeyVisibility = async () => {
		if (showKey) {
			revealFence.invalidate();
			setKeyVisibilityOwner(null);
			setRevealedKey(null);
			return;
		}
		if (keyDraft !== "") {
			setKeyVisibilityOwner(provider);
			return;
		}
		const request = revealFence.begin(provider);
		setKeyRevealOwner(provider);
		try {
			const key = await onGetApiKey();
			if (!revealFence.isCurrent(request, currentProviderRef.current)) return;
			if (key === null) return;
			setRevealedKey({ provider, key });
			setKeyVisibilityOwner(provider);
		} finally {
			if (revealFence.isCurrent(request, currentProviderRef.current)) setKeyRevealOwner(null);
		}
	};
	return {
		detailTitleId,
		onBack,
		t,
		provider,
		busy,
		pushUpdate,
		setConfirmRemove,
		onLogin,
		showKey,
		activeRevealedKey,
		keyDraft,
		revealingKey,
		setKeyDraft,
		revealFence,
		setRevealedKey,
		setKeyRevealOwner,
		toggleKeyVisibility,
		keyDirty,
		saveKey,
		modelListTitleId,
		onAddModel,
		modelSearchId,
		modelQuery,
		setModelQuery,
		visibleModels,
		onViewModel,
		formatContextWindow: formatCompactNumber,
		i18n,
		onDeriveModel,
		onEditModel,
		onRemoveModel,
		setConfirmRemoveProvider,
		confirmRemove,
		setKeyVisibilityOwner,
		onRemoveAuth,
		confirmRemoveProvider,
		onRemoveProvider,
	};
}
