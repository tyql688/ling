import type { ProviderSummary } from "@ling/contracts/model";

/** Project extension providers replace the profile projection for the same id.
 * Sort after replacement because Map.set() intentionally retains the old slot. */
export function mergeProviderCatalogs(
	profileProviders: readonly ProviderSummary[],
	projectProviders: readonly ProviderSummary[],
): ProviderSummary[] {
	const providersById = new Map(profileProviders.map((provider) => [provider.id, provider]));
	for (const provider of projectProviders) providersById.set(provider.id, provider);
	return [...providersById.values()].sort(
		(left, right) => left.displayName.localeCompare(right.displayName, "en") || left.id.localeCompare(right.id, "en"),
	);
}
