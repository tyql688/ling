import { z } from "zod";

/** Which Pi extension produced a tool result, recorded on the transcript branch at call time. */
export const piToolOriginSchema = z.strictObject({
	source: z.string().min(1).max(2_048),
	extension: z
		.string()
		.min(1)
		.max(1_024)
		.refine((value) => !value.split("/").includes(".."), "Extension paths stay inside their source root"),
	scope: z.enum(["global", "project", "temporary"]),
	version: z.string().max(100).nullable(),
	revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PiToolOrigin = z.infer<typeof piToolOriginSchema>;

/** Normalizes an npm source to its package identity so a pinned version still matches. */
export function piPackageSource(source: string): string {
	if (!source.startsWith("npm:")) return source;
	const match = /^(npm:(?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(source);
	return match?.[1] ?? source;
}
