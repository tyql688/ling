export interface ModelPickerOption {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	reasoning: boolean;
}

export interface ModelPickerProvider {
	id: string;
	name: string;
	count: number;
}

export function modelPickerOptionKey(option: Pick<ModelPickerOption, "provider" | "id">): string {
	return JSON.stringify([option.provider, option.id]);
}

type ModelIdentity = Pick<ModelPickerOption, "provider" | "id">;

interface ModelPickerSearchOptions {
	provider?: string | null;
	selected?: ModelIdentity | null | undefined;
	defaultModel?: ModelIdentity | null | undefined;
}

function sameModel(option: ModelPickerOption, model: ModelIdentity | null | undefined): boolean {
	return option.provider === model?.provider && option.id === model.id;
}

/** Pi TUI's subsequence score: consecutive and word-boundary matches precede scattered matches.
 * Adapted from packages/tui/src/fuzzy.ts; attribution is in THIRD_PARTY_NOTICES.md. */
function matchToken(query: string, text: string): { score: number; indices: number[] } | null {
	if (query.length > text.length) return null;
	let score = 0;
	let previous = -1;
	let consecutive = 0;
	const indices: number[] = [];
	for (const character of query) {
		const index = text.indexOf(character, previous + 1);
		if (index < 0) return null;
		for (let offset = 0; offset < character.length; offset += 1) indices.push(index + offset);
		if (index === previous + 1) {
			consecutive += 1;
			score -= consecutive * 5;
		} else {
			consecutive = 0;
			if (previous >= 0) score += (index - previous - 1) * 2;
		}
		if (index === 0 || /[\s\-_./:]/.test(text.charAt(index - 1))) score -= 10;
		score += index * 0.1;
		previous = index;
	}
	return { score: score - (query === text ? 100 : 0), indices };
}

function fuzzyTokenMatch(query: string, text: string) {
	const primary = matchToken(query, text);
	if (primary !== null) return primary;
	const parts = /^([a-z]+)([0-9]+)$/.exec(query) ?? /^([0-9]+)([a-z]+)$/.exec(query);
	if (!parts) return null;
	const swapped = matchToken(`${parts[2]}${parts[1]}`, text);
	// Pi only swaps a letter/number token after the original order fails, with a small ranking penalty.
	return swapped === null ? null : { ...swapped, score: swapped.score + 5 };
}

function queryScore(tokens: readonly string[], text: string): number | null {
	let score = 0;
	for (const token of tokens) {
		const match = fuzzyTokenMatch(token, text);
		if (match === null) return null;
		score += match.score;
	}
	return score;
}

/** Provider lookup searches identities, never the names of models they happen to serve. */
export function filterModelPickerProviders(providers: readonly ModelPickerProvider[], query: string) {
	const tokens = query
		.trim()
		.toLowerCase()
		.split(/[\s/]+/)
		.filter(Boolean);
	return providers
		.map((provider) => {
			const fields = [provider.id.toLowerCase(), provider.name.toLowerCase()];
			let score = 0;
			for (const token of tokens) {
				// Match within a field so repeating the same name/ID cannot invent an abbreviation.
				const matches = fields.map((field) => fuzzyTokenMatch(token, field)).filter((match) => match !== null);
				if (matches.length === 0) return null;
				score += Math.min(...matches.map((match) => match.score));
			}
			return { provider, score };
		})
		.filter((entry) => entry !== null)
		.sort((a, b) => a.score - b.score || a.provider.name.localeCompare(b.provider.name))
		.map(({ provider }) => provider);
}

/** Highlight each matching token in a visible field, including Pi's letter/number fallback. */
export function modelPickerMatchParts(
	text: string,
	query: string,
): { text: string; matched: boolean; start: number }[] {
	if (!query.trim()) return [{ text, matched: false, start: 0 }];
	const normalized = text.toLowerCase();
	const indices = new Set(
		query
			.trim()
			.toLowerCase()
			.split(/[\s/]+/)
			.filter(Boolean)
			.flatMap((token) => fuzzyTokenMatch(token, normalized)?.indices ?? []),
	);
	const parts: { text: string; matched: boolean; start: number }[] = [];
	let offset = 0;
	let sourceOffset = 0;
	for (const character of text) {
		// Case folding can expand one original character; never slice the displayed label by folded offsets.
		const length = character.toLowerCase().length;
		const matched = Array.from({ length }, (_, index) => indices.has(offset + index)).some(Boolean);
		const previous = parts.at(-1);
		if (previous?.matched === matched) previous.text += character;
		else parts.push({ text: character, matched, start: sourceOffset });
		offset += length;
		sourceOffset += character.length;
	}
	return parts;
}

/** Match Pi's /model query grammar and ranking while also searching Ling's provider display names. */
export function filterModelPickerOptions(
	options: readonly ModelPickerOption[],
	query: string,
	{ provider = null, selected, defaultModel }: ModelPickerSearchOptions = {},
): ModelPickerOption[] {
	const normalized = query.trim().toLowerCase();
	const tokens = normalized.split(/[\s/]+/).filter(Boolean);
	const candidates = options
		.filter((option) => provider === null || option.provider === provider)
		.sort((a, b) => {
			const current = Number(sameModel(b, selected)) - Number(sameModel(a, selected));
			const defaults = Number(sameModel(b, defaultModel)) - Number(sameModel(a, defaultModel));
			return current || defaults || a.provider.localeCompare(b.provider);
		});
	if (tokens.length === 0) return candidates;
	const ranked: { option: ModelPickerOption; score: number }[] = [];
	for (const option of candidates) {
		// Provider-first text keeps direct provider queries ahead of proxy-provider model IDs.
		const alias = option.providerName.toLowerCase() === option.provider.toLowerCase() ? "" : ` ${option.providerName}`;
		const text =
			`${option.provider} ${option.provider}/${option.id} ${option.provider} ${option.id} ${option.name}${alias}${sameModel(option, defaultModel) ? " default" : ""}`.toLowerCase();
		const score = queryScore(tokens, text);
		if (score !== null) ranked.push({ option, score });
	}
	const result = ranked.sort((a, b) => a.score - b.score).map(({ option }) => option);
	return "default".startsWith(normalized)
		? [
				...candidates.filter((option) => sameModel(option, defaultModel)),
				...result.filter((option) => !sameModel(option, defaultModel)),
			]
		: result;
}
