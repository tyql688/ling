import { createContext } from "react";

/** Workspace root that markdown image paths resolve against, or null on surfaces with no
 * project behind them (settings previews, skill descriptions) where images cannot be served. */
export const MarkdownImageRootContext = createContext<string | null>(null);

/** A document supplies its directory without changing the authenticated project root. */
export const MarkdownDocumentContext = createContext<{
	resolve(source: string): string | null;
	open(path: string): void;
} | null>(null);
