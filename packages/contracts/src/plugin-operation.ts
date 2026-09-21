export type PluginMutationAction = "install" | "remove" | "update";

/** Shared owner id for plugin install/remove/update: the operation registry uses this id + revision to enforce mutual exclusion and avoid concurrent package mutations. */
export const PLUGIN_MUTATION_OWNER_ID = "plugins.mutation";

/**
 * Default deadline span the renderer writes when starting install/remove/update.
 * npm network operations usually take minutes; 10min is the product-side cancellable hard cap (main clamps higher).
 */
export const PLUGIN_MUTATION_DEADLINE_MS = 10 * 60_000;

/**
 * Maximum deadline span the main operation registry accepts. Clamps the caller-supplied deadlineAt
 * so an operation can never hang without timing out; must be ≥ {@link PLUGIN_MUTATION_DEADLINE_MS}.
 */
export const PLUGIN_MUTATION_MAX_DEADLINE_MS = 30 * 60_000;

export function pluginMutationRevision(
	action: PluginMutationAction,
	source: string | null,
	cwd: string,
	scope: "global" | "project" | "all",
): string {
	const sourcePart = source === null ? "*" : `${source.length}:${source}`;
	return `${action}|${scope}|${cwd.length}:${cwd}|${sourcePart}`;
}
