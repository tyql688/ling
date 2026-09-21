import type { BoundedJsonObject } from "@ling/contracts/bounded-json";

interface ModelConfigObjectDraft {
	value: BoundedJsonObject | null;
	error: string | null;
}

/** Parses an optional models.json object without coupling the editor to one schema. */
export function parseModelConfigObjectDraft(
	draft: string,
	validate: (value: unknown) => string | null,
	invalidJsonMessage: string,
	invalidValueMessage: (issue: string) => string,
): ModelConfigObjectDraft {
	if (draft.trim() === "") return { value: null, error: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(draft);
	} catch {
		return { value: null, error: invalidJsonMessage };
	}
	const issue = validate(parsed);
	return issue
		? { value: null, error: invalidValueMessage(issue) }
		: { value: parsed as BoundedJsonObject, error: null };
}
