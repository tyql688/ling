import { z } from "zod";
import {
	defaultSessionToolFilter,
	sessionToolFilterSchema,
	type SessionToolFilter,
} from "@ling/contracts/session-tool-filter";
import type { PiSessionManager } from "../types";

const entryType = "ling:tool-filter";
const entrySchema = z.strictObject({ version: z.literal(1), filter: sessionToolFilterSchema });

/** Runtime settings belong to the session file, including when navigating its earlier branches. */
export function readSessionToolFilter(manager: PiSessionManager): SessionToolFilter {
	const entry = manager.getEntries().findLast((item) => item.type === "custom" && item.customType === entryType);
	if (!entry || entry.type !== "custom") return defaultSessionToolFilter();
	return entrySchema.parse(entry.data).filter;
}

export function appendSessionToolFilter(manager: PiSessionManager, filter: SessionToolFilter): void {
	manager.appendCustomEntry(entryType, { version: 1, filter });
}
