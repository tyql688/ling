import { z } from "zod";

// Bound the matchers compiled by Pi and the session metadata sent over the wire.
const patterns = z.array(z.string().trim().min(1).max(1024)).max(128);
const toolSelection = patterns.refine((entries) => {
	const modifiers = entries.filter((entry) => entry.startsWith("+") || entry.startsWith("-"));
	return (
		modifiers.length === 0 ||
		(modifiers.length === entries.length && modifiers.every((entry) => entry.length > 1 && !entry.includes("*")))
	);
}, "Choose tool names and patterns, or use only +name/-name entries with exact names");

export const sessionToolFilterSchema = z.strictObject({
	/** null inherits Pi's defaults; an empty list disables every tool. */
	tools: toolSelection.nullable(),
	excludeTools: patterns,
	disableMcp: z.boolean(),
});

export type SessionToolFilter = z.infer<typeof sessionToolFilterSchema>;

export function defaultSessionToolFilter(): SessionToolFilter {
	return { tools: null, excludeTools: [], disableMcp: false };
}
