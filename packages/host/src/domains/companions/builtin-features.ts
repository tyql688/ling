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

const legacyIds: Record<Exclude<BuiltinFeatureId, "voice" | "mcp">, string> = {
	todo: "ling-todo",
	permissions: "ling-permission-system",
	questions: "ling-questions",
	"background-tasks": "ling-background-tasks",
	schedules: "ling-schedules",
};
const legacySchema = z.object({ version: z.literal(1), disabled: z.array(z.string()).optional() });

/** Owns Host feature switches and projects Pi's canonical MCP activation. */
export function createBuiltinFeatures(
	home: string,
	mcp?: {
		read(): Promise<boolean>;
		write(enabled: boolean, expected?: boolean): Promise<boolean>;
	},
) {
	const storedSchema = builtinFeaturesSchema.extend({ piMcp: z.boolean().optional() });
	const store = createAtomicFileStore<z.infer<typeof storedSchema>>({
		getPath: () => join(home, "plugin-state", "builtin-features.json"),
		lockPath: "configured",
		// Retain the old plugin settings read budget for migration; normal switches occupy less than 1 KiB.
		maxBytes: 256 * 1024,
		create: () => {
			const source = readUtf8FileSyncBounded(join(home, "plugin-state", "plugins.json"), 256 * 1024);
			// Built-ins were enabled unless explicitly disabled; absence means a new installation.
			const disabled = new Set(source === undefined ? [] : legacySchema.parse(JSON.parse(source)).disabled);
			return {
				...(mcp && source === undefined ? { piMcp: true } : {}),
				revision: 0,
				enabled: {
					...Object.fromEntries(Object.entries(legacyIds).map(([id, legacy]) => [id, !disabled.has(legacy)])),
					// Microphone input is opt-in; installing a Pi voice package does not opt in to Ling's controls.
					voice: false,
					mcp: false,
				} as BuiltinFeatures["enabled"],
				schedulesResumedAt: null,
			};
		},
		parse: (source) => {
			// Existing installations predate these opt-in features.
			const value = z
				.object({ enabled: z.object({ voice: z.boolean().optional(), mcp: z.boolean().optional() }).loose() })
				.loose()
				.parse(JSON.parse(source));
			return storedSchema.parse({
				...value,
				enabled: { ...value.enabled, voice: value.enabled.voice ?? false, mcp: value.enabled.mcp ?? false },
			});
		},
		serialize: (value) => `${JSON.stringify(value, null, 2)}\n`,
	});
	function publicState(value: z.infer<typeof storedSchema>): BuiltinFeatures {
		return { revision: value.revision, enabled: value.enabled, schedulesResumedAt: value.schedulesResumedAt };
	}
	async function read(): Promise<BuiltinFeatures> {
		if (!mcp) return publicState(await store.read());
		return store.transact(async (value) => {
			let changed = false;
			if (!value.piMcp) {
				// Carry the user's effective Ling choice into Pi before sharing activation.
				await mcp.write(value.enabled.mcp);
				value.piMcp = true;
				changed = true;
			}
			const enabled = await mcp.read();
			if (value.enabled.mcp !== enabled) {
				value.enabled.mcp = enabled;
				value.revision++;
				changed = true;
			}
			return { commit: changed, result: publicState(value) };
		});
	}
	return {
		read,
		// Worker callbacks must not call back into the worker while it is resolving resources.
		readHost: async () => publicState(await store.read()),
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
			return store.transact(
				async (value) => {
					signal.throwIfAborted();
					if (value.revision !== input.expectedRevision)
						throw new Error("Feature settings changed. Refresh before saving.");
					if (input.id === "mcp" && mcp) {
						const changed = await mcp.write(input.enabled, value.enabled.mcp);
						if (!changed && value.piMcp) return { commit: false, result: false };
						value.piMcp = true;
						value.enabled.mcp = input.enabled;
						value.revision++;
						return { commit: true, result: true };
					}
					if (value.enabled[input.id] === input.enabled) return { commit: false, result: false };
					value.enabled[input.id] = input.enabled;
					if (input.id === "schedules" && input.enabled) value.schedulesResumedAt = Date.now();
					value.revision++;
					return { commit: true, result: true };
				},
				{ signal },
			);
		},
	};
}
export type BuiltinFeatureStore = ReturnType<typeof createBuiltinFeatures>;
