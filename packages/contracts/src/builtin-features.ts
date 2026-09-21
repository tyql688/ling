import { z } from "zod";

export const builtinFeatureIdSchema = z.enum(["todo", "permissions", "questions", "background-tasks", "schedules"]);
export type BuiltinFeatureId = z.infer<typeof builtinFeatureIdSchema>;

export const builtinFeatureFlagsSchema = z.record(builtinFeatureIdSchema, z.boolean());
export type BuiltinFeatureFlags = z.infer<typeof builtinFeatureFlagsSchema>;

export const builtinFeaturesSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	enabled: builtinFeatureFlagsSchema,
	/** Occurrences due while scheduling was disabled must not run when it is enabled again. */
	schedulesResumedAt: z.number().int().nonnegative().nullable(),
});
export type BuiltinFeatures = z.infer<typeof builtinFeaturesSchema>;

export const builtinFeatureUpdateSchema = z.strictObject({
	id: builtinFeatureIdSchema,
	enabled: z.boolean(),
	expectedRevision: z.number().int().nonnegative(),
});
export type BuiltinFeatureUpdate = z.infer<typeof builtinFeatureUpdateSchema>;
