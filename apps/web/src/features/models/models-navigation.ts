import type { ProviderSummary } from "@ling/contracts/model";

type ModelsNavigationPane = "providers" | "detail";

interface ModelsNavigationState {
	selectedId: string | null;
	pane: ModelsNavigationPane;
}

type ModelsNavigationAction = { type: "selectProvider"; providerId: string } | { type: "showProviders" };

/** Initial models-settings navigation state: no provider selected, parked on the list pane. */
export const INITIAL_MODELS_NAVIGATION: ModelsNavigationState = {
	selectedId: null,
	pane: "providers",
};

export function modelsNavigationReducer(
	state: ModelsNavigationState,
	action: ModelsNavigationAction,
): ModelsNavigationState {
	switch (action.type) {
		case "selectProvider":
			return { selectedId: action.providerId, pane: "detail" };
		case "showProviders":
			return state.pane === "providers" ? state : { ...state, pane: "providers" };
	}
}

/** A failed auth.json read makes stored credentials unknown, but must not block a
 * separately confirmed runtime, environment, or models.json auth source. */
export function isProviderUsable(provider: ProviderSummary): boolean {
	return (
		!provider.authConflict &&
		provider.configured &&
		(provider.credentialStatus === "known" || (provider.source !== null && provider.source !== "stored"))
	);
}

/**
 * Desktop always has a detail pane, even before an explicit selection. Mobile keeps
 * that default selection latent until the user enters the detail pane.
 */
export function resolveSelectedProvider(
	providers: readonly ProviderSummary[],
	requestedId: string | null,
): ProviderSummary | null {
	if (providers.length === 0) return null;
	const requested = providers.find((provider) => provider.id === requestedId);
	if (requested) return requested;
	return providers.find(isProviderUsable) ?? providers[0] ?? null;
}

/** A removed provider must return narrow layouts to the list instead of opening a fallback provider. */
export function isModelsDetailPaneActive(navigation: ModelsNavigationState, selected: ProviderSummary | null): boolean {
	return navigation.pane === "detail" && selected?.id === navigation.selectedId;
}
