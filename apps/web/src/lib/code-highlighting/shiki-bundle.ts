import { createBundledHighlighter, createSingletonShorthands } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledThemes } from "shiki/themes";
import { bundledLanguages } from "./languages";

// Vite substitutes this public Shiki bundle for Pierre's full bundle import. Subpath
// imports remain untouched, including the worker's core and regex engines.
export { bundledLanguages };
export { createCssVariablesTheme, getTokenStyleObject, stringifyTokenStyle } from "shiki/core";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";
export { createOnigurumaEngine };

export const createHighlighter = createBundledHighlighter({
	langs: bundledLanguages,
	themes: bundledThemes,
	engine: () => createOnigurumaEngine(import("shiki/wasm")),
});

export const { codeToHtml } = createSingletonShorthands(createHighlighter);
