import { basenameFromPath } from "@renderer/lib/format-path";
import { createContext, useContext } from "react";

/** The changed-file vocabulary a markdown surface can link inline code against. */
interface MarkdownFileMentions {
	/** The changed file an inline-code token names, or null when it names none. */
	resolve(token: string): string | null;
	open(path: string): void;
}

/** Null for settings previews and skill descriptions, where inline code has no changed-file links. */
export const MarkdownFileMentionsContext = createContext<MarkdownFileMentions | null>(null);

export function useMarkdownFileMentions(): MarkdownFileMentions | null {
	return useContext(MarkdownFileMentionsContext);
}

/** Trailing `:120` or `:120:8`, the form a model writes when it cites a line in a path. */
const POSITION_SUFFIX = /:\d+(?::\d+)?$/u;

function normalizeToken(token: string): string {
	// A model on Windows may write the OS separator; changed paths are always Git-style.
	const normalized = token.trim().replaceAll("\\", "/");
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/** Resolves a token to an exact changed path or a basename shared by exactly one changed path. Ambiguous basenames return null. Every resolved value comes from `paths`, which supplies the file passed to `open`. */
export function createMarkdownFileMentions(
	paths: readonly string[],
	open: (path: string) => void,
): MarkdownFileMentions {
	const byPath = new Set(paths);
	// null marks a basename that two different paths claim.
	const byBasename = new Map<string, string | null>();
	for (const path of paths) {
		const basename = basenameFromPath(path);
		const claimed = byBasename.get(basename);
		byBasename.set(basename, claimed === undefined || claimed === path ? path : null);
	}
	const lookup = (candidate: string): string | null =>
		byPath.has(candidate) ? candidate : (byBasename.get(candidate) ?? null);
	return {
		resolve(token) {
			const normalized = normalizeToken(token);
			if (normalized.length === 0) return null;
			const direct = lookup(normalized);
			if (direct !== null) return direct;
			const withoutPosition = normalized.replace(POSITION_SUFFIX, "");
			return withoutPosition === normalized ? null : lookup(withoutPosition);
		},
		open,
	};
}
