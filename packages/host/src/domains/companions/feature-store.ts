import { join } from "node:path";
import { createAtomicFileStore } from "@ling/core/store/atomic-file-store";
import { z } from "zod";

const fileSchema = z.record(z.string(), z.strictObject({ revision: z.number().int().nonnegative(), value: z.json() }));

/** Feature data under the Ling data home keeps the directory each feature's files were first written to. */
export function featureDataPath(home: string, feature: string, ...path: string[]): string {
	return join(home, "plugin-data", feature, ...path);
}

/** One durable value per feature under the Ling data home. Updates are serialized by the atomic store. */
export function createFeatureStore<Value>(options: {
	home: string;
	directory: string;
	key: string;
	schema: z.ZodType<Value>;
	initial: () => Value;
}) {
	const file = createAtomicFileStore({
		getPath: () => featureDataPath(options.home, options.directory, "host-state.json"),
		lockPath: "configured",
		maxBytes: 8 * 1_048_576,
		create: (): z.infer<typeof fileSchema> => ({}),
		parse: (source) => fileSchema.parse(JSON.parse(source) as unknown),
		serialize: (value) => JSON.stringify(value),
	});
	const valueOf = (stored: z.infer<typeof fileSchema>) => {
		const record = stored[options.key];
		return record === undefined || record.value === null ? options.initial() : options.schema.parse(record.value);
	};
	return {
		read: async () => valueOf(await file.read()),
		update: (mutate: (value: Value) => Value) =>
			file.update((stored) => {
				const value = options.schema.parse(mutate(valueOf(stored)));
				stored[options.key] = { revision: (stored[options.key]?.revision ?? 0) + 1, value: z.json().parse(value) };
				return value;
			}),
	};
}
