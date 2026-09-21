import { createAtomicFileStore } from "@ling/core/store/atomic-file-store";
import { join } from "node:path";

/** settings.json byte limit (4MiB); settings should be far smaller, anything larger is rejected as suspected corruption. */
const MAX_SETTINGS_JSON_BYTES = 4 * 1024 * 1024;

function parseGlobalSettings(source: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(source.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error("Pi settings must contain valid JSON", { cause: error });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Pi settings must contain a JSON object");
	}
	return value as Record<string, unknown>;
}

export function createPiGlobalSettingsStore(agentDir: string) {
	return createAtomicFileStore<Record<string, unknown>>({
		getPath: () => join(agentDir, "settings.json"),
		// Pi's SettingsManager locks the configured settings.json pathname even when it is a
		// symlink. Use the same lock for reads and while atomically replacing the resolved
		// target because SettingsManager writes the configured file in place.
		lockPath: "configured",
		lockReads: true,
		maxBytes: MAX_SETTINGS_JSON_BYTES,
		create: () => ({}),
		parse: parseGlobalSettings,
		serialize: (settings) => `${JSON.stringify(settings, null, 2)}\n`,
	});
}
export type PiGlobalSettingsStore = ReturnType<typeof createPiGlobalSettingsStore>;
