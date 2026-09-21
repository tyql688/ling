import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readUtf8FileBounded } from "@ling/core/store/atomic-file-store";
import { join } from "node:path";
import { z } from "zod";

/** The shared catalog can contain thousands of models; bound its read to 64 MiB. */
const CATALOG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
type RuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;
type CatalogStore = NonNullable<RuntimeOptions["modelsStore"]>;
const cachedCatalogEntrySchema = z.looseObject({
	models: z.array(
		z.looseObject({
			id: z.string().min(1),
			provider: z.string().min(1),
			name: z.string().min(1),
			api: z.string().min(1),
			baseUrl: z.string(),
			reasoning: z.boolean(),
			input: z.array(z.enum(["text", "image"])),
			contextWindow: z.number().positive(),
			maxTokens: z.number().positive(),
			cost: z.looseObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
		}),
	),
	checkedAt: z.number().optional(),
	lastModified: z.number().optional(),
	etag: z.string().optional(),
});

/** Recompose only the official static/cache layers through Pi, so custom upserts
 * cannot disguise themselves as newly published models. This runtime never writes
 * credentials or cache data and never makes a network request. */
export async function readCatalogModelSource(
	agentDir: string,
	providers: string[],
	signal: AbortSignal,
): Promise<{ runtime: ModelRuntime; errors: Map<string, Error> }> {
	const source = await readUtf8FileBounded(join(agentDir, "models-store.json"), CATALOG_CACHE_MAX_BYTES, signal);
	// A profile that has never updated its catalog legitimately has no cache yet.
	const cache = source === undefined ? {} : z.record(z.string(), z.unknown()).parse(JSON.parse(source));
	const readOnly = async (): Promise<never> => {
		throw new Error("The model catalog inspection runtime is read-only");
	};
	const modelsStore: CatalogStore = {
		read: async (provider) => {
			if (!Object.hasOwn(cache, provider)) return undefined;
			const entry = cachedCatalogEntrySchema.parse(cache[provider]);
			return {
				models: entry.models,
				...(entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt }),
				...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
				...(entry.etag === undefined ? {} : { etag: entry.etag }),
			};
		},
		write: readOnly,
		delete: readOnly,
	};
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		modelsStore,
		allowModelNetwork: false,
		refreshOnCreate: false,
		signal,
		credentials: { read: async () => undefined, list: async () => [], modify: readOnly, delete: readOnly },
	});
	const refreshed = await runtime.refresh({ allowNetwork: false, providers, signal });
	if (refreshed.aborted) throw new Error("Model catalog inspection was cancelled");
	return { runtime, errors: new Map(refreshed.errors) };
}
