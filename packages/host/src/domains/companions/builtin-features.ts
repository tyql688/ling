import { join } from "node:path";
import { z } from "zod";
import { createAtomicFileStore, readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import { createLingError } from "@ling/core/ling-error";
import {
	builtinFeaturesSchema,
	type BuiltinFeatures,
	type BuiltinFeatureId,
	type BuiltinFeatureUpdate,
} from "@ling/contracts/builtin-features";

const legacyIds: Record<BuiltinFeatureId, string> = {
	todo: "ling-todo",
	permissions: "ling-permission-system",
	questions: "ling-questions",
	"background-tasks": "ling-background-tasks",
	schedules: "ling-schedules",
};
const legacySchema = z.object({ version: z.literal(1), disabled: z.array(z.string()).optional() });

/** Owns first-party feature switches without loading the retired plugin runtime or changing Pi settings. */
export function createBuiltinFeatures(home: string) {
	const store = createAtomicFileStore<BuiltinFeatures>({
		getPath: () => join(home, "plugin-state", "builtin-features.json"),
		lockPath: "configured",
		// Retain the old plugin settings read budget for migration; normal switches occupy less than 1 KiB.
		maxBytes: 256 * 1024,
		create: () => {
			const source = readUtf8FileSyncBounded(join(home, "plugin-state", "plugins.json"), 256 * 1024);
			// Built-ins were enabled unless explicitly disabled; absence means a new installation.
			const disabled = new Set(source === undefined ? [] : legacySchema.parse(JSON.parse(source)).disabled);
			return {
				revision: 0,
				enabled: Object.fromEntries(
					Object.entries(legacyIds).map(([id, legacy]) => [id, !disabled.has(legacy)]),
				) as BuiltinFeatures["enabled"],
				schedulesResumedAt: null,
			};
		},
		parse: (source) => builtinFeaturesSchema.parse(JSON.parse(source)),
		serialize: (value) => `${JSON.stringify(value, null, 2)}\n`,
	});
	return {
		read: () => store.read(),
		async requireEnabled(id: BuiltinFeatureId) {
			if (!(await store.read()).enabled[id])
				throw createLingError({
					code: "BUILTIN_FEATURE_DISABLED",
					category: "lifecycle",
					message: `The ${id} feature is disabled. Enable it in Settings > Plugins.`,
					retryable: false,
				});
		},
		write(input: BuiltinFeatureUpdate, signal: AbortSignal) {
			return store.update(
				(value) => {
					signal.throwIfAborted();
					if (value.revision !== input.expectedRevision)
						throw new Error("Feature settings changed. Refresh before saving.");
					if (value.enabled[input.id] === input.enabled) return;
					value.enabled[input.id] = input.enabled;
					if (input.id === "schedules" && input.enabled) value.schedulesResumedAt = Date.now();
					value.revision++;
				},
				{ signal },
			);
		},
	};
}
export type BuiltinFeatureStore = ReturnType<typeof createBuiltinFeatures>;
