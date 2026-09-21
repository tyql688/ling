import type { CompletionItem } from "@renderer/components/ui/completion-panel";
import { defaultFilter } from "cmdk";

/** Search both invocation and explanation while keeping each source's group together. */
export function searchCompletions<T extends CompletionItem>(items: readonly T[], query: string): T[] {
	if (!query) return [...items];
	return items.filter((item) => defaultFilter(item.name, query, [item.description, item.displayText ?? ""]) > 0);
}
