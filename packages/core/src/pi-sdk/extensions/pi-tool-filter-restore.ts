import type { PiLoadExtensionsResult } from "../types";

/** A revocable Pi extension must not strand tools hidden by its per-turn filter after unload. */
export function restoreToolFiltersOnShutdown(
	extension: PiLoadExtensionsResult["extensions"][number],
	runtime: PiLoadExtensionsResult["runtime"],
) {
	const handlers = extension.handlers.get("before_agent_start");
	if (!handlers?.length) return;
	const withheld = new Set<string>();
	extension.handlers.set(
		"before_agent_start",
		handlers.map((handler) => async (...args) => {
			const before = runtime.getActiveTools();
			try {
				return await handler(...args);
			} finally {
				const active = new Set(runtime.getActiveTools());
				const registered = new Set(runtime.getAllTools().map((tool) => tool.name));
				for (const name of withheld) if (active.has(name) || !registered.has(name)) withheld.delete(name);
				for (const name of before) if (!active.has(name) && registered.has(name)) withheld.add(name);
			}
		}),
	);
	extension.handlers.set("session_shutdown", [
		async () => {
			if (withheld.size === 0) return;
			const registered = new Set(runtime.getAllTools().map((tool) => tool.name));
			const restored = [...withheld].filter((name) => registered.has(name));
			runtime.setActiveTools([...new Set([...runtime.getActiveTools(), ...restored])]);
			withheld.clear();
		},
		// The extension's own shutdown handlers retain the final say over deliberate tool-selection changes.
		...(extension.handlers.get("session_shutdown") ?? []),
	]);
}
