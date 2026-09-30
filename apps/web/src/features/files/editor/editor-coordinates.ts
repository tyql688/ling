import * as monaco from "monaco-editor";
import type { Range } from "@ling/contracts/editor-language";
export function editorRange(range: Range): monaco.Range {
	return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}
export function languageRange(range: monaco.IRange): Range {
	return {
		start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
		end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
	};
}
export function languagePosition(position: monaco.IPosition) {
	return { line: position.lineNumber - 1, character: position.column - 1 };
}
export function projectLanguagePath(cwd: string, uri: string): string {
	const value = new URL(uri);
	if (value.protocol !== "file:") throw new Error("Only project file locations can open in the editor");
	let path = decodeURIComponent(value.pathname);
	if (value.hostname && value.hostname !== "localhost") path = `//${value.hostname}${path}`;
	const root = cwd.replaceAll("\\", "/").replace(/\/$/, "");
	if (/^[a-z]:/i.test(root)) path = path.replace(/^\//, "");
	const windows = /^[a-z]:/i.test(root) || root.startsWith("//");
	if (!(windows ? path.toLowerCase() : path).startsWith(`${windows ? root.toLowerCase() : root}/`))
		throw new Error("This definition is outside the open project");
	path = path.slice(root.length + 1);
	if (path.split(/[\\/]/).includes("..")) throw new Error("The definition escapes the project");
	return path;
}
