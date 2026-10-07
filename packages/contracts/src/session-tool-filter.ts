import { z } from "zod";

// Bound the matchers compiled by Pi and the session metadata sent over the wire.
const patterns = z.array(z.string().trim().min(1).max(1024)).max(128);

export const sessionToolFilterSchema = z.strictObject({
	/** null inherits Pi's defaults; an empty list disables every tool. */
	tools: patterns.nullable(),
	excludeTools: patterns,
	disableMcp: z.boolean(),
});

export type SessionToolFilter = z.infer<typeof sessionToolFilterSchema>;

export function defaultSessionToolFilter(): SessionToolFilter {
	return { tools: null, excludeTools: [], disableMcp: false };
}
