/**
 * Hard cap for Mermaid rendering: source length / line count / complexity over the limit
 * skips diagram rendering, so a malicious or accidental giant diagram can't freeze the
 * main thread.
 */
const MERMAID_RENDER_LIMITS = {
	maxSourceChars: 20_000,
	maxLines: 600,
	maxComplexityScore: 1_500,
} as const;

/** Edge/arrow-like tokens: coarse diagram-complexity estimate without parsing the full grammar. */
const EDGE_LIKE_TOKEN = /(?:<-->|<--|-->|---|-\.->|==>|--x|--o|x--|o--)/gu;
/** Node-like tokens: line-start identifier + square/round/curly-brace label — the other dimension of the complexity score. */
const NODE_LIKE_TOKEN = /(?:^|\n)\s*[A-Za-z][\w-]*(?:\[[^\]\n]{0,200}\]|\([^)\n]{0,200}\)|\{[^}\n]{0,200}\})/gu;

function countMatches(source: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	let count = 0;
	while (pattern.exec(source)) count += 1;
	return count;
}

function countLines(source: string): number {
	if (source.length === 0) return 0;
	let count = 1;
	for (let index = 0; index < source.length; index += 1) {
		if (source.charCodeAt(index) === 10) count += 1;
	}
	return count;
}

export function canRenderMermaid(source: string): boolean {
	if (source.length > MERMAID_RENDER_LIMITS.maxSourceChars) return false;
	const lineCount = countLines(source);
	if (lineCount > MERMAID_RENDER_LIMITS.maxLines) return false;
	const complexityScore = lineCount + countMatches(source, EDGE_LIKE_TOKEN) + countMatches(source, NODE_LIKE_TOKEN);
	return complexityScore <= MERMAID_RENDER_LIMITS.maxComplexityScore;
}
