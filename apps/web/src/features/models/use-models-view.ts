import type { ProviderModelInfo, ProviderSummary } from "@ling/contracts/model";

import { useAppFeedback } from "@renderer/lib/feedback-context";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import {
	INITIAL_MODELS_NAVIGATION,
	isModelsDetailPaneActive,
	modelsNavigationReducer,
	resolveSelectedProvider,
} from "./models-navigation";

import { useProviders } from "./use-providers";

export type ModelsViewProps = { providerProjectCwd: string | null };

/** Owns the form's asynchronous work, recovery state and submission intent. */
export function useModelsView({ providerProjectCwd }: ModelsViewProps) {
	const { t } = useTranslation();
	const feedback = useAppFeedback();

	const {
		providers,
		error,
		busy,
		catalogRefreshing,
		catalogRefreshResult,
		refresh,
		refreshCatalogs,
		cancelCatalogRefresh,
		getApiKey,
		setApiKey,
		removeAuth,
		removeModel,
		removeProvider,
		updateProvider,
	} = useProviders(providerProjectCwd);
	const [navigation, dispatchNavigation] = useReducer(modelsNavigationReducer, INITIAL_MODELS_NAVIGATION);
	const [login, setLogin] = useState<{
		provider: ProviderSummary;
		method: "api_key" | "oauth";
	} | null>(null);
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	/** Every form retains the provider/catalog that owns its draft. */
	const [modelForm, setModelForm] = useState<{
		provider: ProviderSummary;
		initial: ProviderModelInfo | null;
		referenceId: string | null;
	} | null>(null);
	const [modelDetails, setModelDetails] = useState<{ provider: ProviderSummary; model: ProviderModelInfo } | null>(
		null,
	);
	const modelsContainerRef = useRef<HTMLDivElement>(null);
	const previousPaneRef = useRef<"providers" | "detail">("providers");

	const providerList = providers ?? [];
	const selected = resolveSelectedProvider(providerList, navigation.selectedId);
	const detailPaneActive = isModelsDetailPaneActive(navigation, selected);
	const visiblePane = detailPaneActive ? "detail" : "providers";
	const catalogRefreshWarn =
		catalogRefreshResult !== null &&
		(catalogRefreshResult.aborted || catalogRefreshResult.timedOut || catalogRefreshResult.errors.length > 0);

	useEffect(() => {
		if (catalogRefreshResult === null || catalogRefreshWarn) return;
		feedback.show({
			tone: "success",
			title: t("models.catalogRefreshSuccess"),
			dedupeKey: "model-catalog-refresh",
		});
	}, [catalogRefreshResult, catalogRefreshWarn, feedback, t]);

	useLayoutEffect(() => {
		const previousPane = previousPaneRef.current;
		previousPaneRef.current = visiblePane;
		if (previousPane === visiblePane) return;

		const container = modelsContainerRef.current;
		if (!container) return;
		const target =
			visiblePane === "detail"
				? container.querySelector<HTMLButtonElement>("[data-models-back]")
				: [...container.querySelectorAll<HTMLButtonElement>("[data-provider-id]")].find(
						(button) => button.dataset.providerId === selected?.id,
					);
		// Container queries leave both panes mounted on wide layouts. Only move focus when the
		// corresponding control is actually rendered; desktop provider selection then retains its
		// existing focus, while the narrow list -> detail flow never drops keyboard users on <body>.
		if (target && target.getClientRects().length > 0) target.focus();
	}, [selected?.id, visiblePane]);

	const selectProvider = (providerId: string) => {
		dispatchNavigation({ type: "selectProvider", providerId });
	};
	return {
		t,
		catalogRefreshing,
		cancelCatalogRefresh,
		refreshCatalogs,
		providers,
		busy,
		error,
		refresh,
		catalogRefreshResult,
		catalogRefreshWarn,
		providerList,
		setAddProviderOpen,
		modelsContainerRef,
		visiblePane,
		selected,
		selectProvider,
		dispatchNavigation,
		getApiKey,
		setApiKey,
		removeAuth,
		setLogin,
		setModelForm,
		setModelDetails,
		removeModel,
		removeProvider,
		updateProvider,
		login,
		addProviderOpen,
		modelDetails,
		modelForm,
	};
}
