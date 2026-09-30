import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { typescript } from "monaco-editor";
import { configureEditorJsonSchemas } from "./editor-json-schemas";

// Project semantics belong to Host's language server. The local worker keeps syntax feedback
// available during startup without producing competing project-free completion and diagnostics.
for (const defaults of [typescript.typescriptDefaults, typescript.javascriptDefaults]) {
	defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
	defaults.setModeConfiguration({
		diagnostics: true,
		completionItems: false,
		hovers: false,
		documentSymbols: false,
		definitions: false,
		references: false,
		documentHighlights: false,
		rename: false,
		documentRangeFormattingEdits: false,
		signatureHelp: false,
		onTypeFormattingEdits: false,
		codeActions: false,
		inlayHints: false,
	});
}
configureEditorJsonSchemas();

interface MonacoEnvironment {
	getWorker(moduleId: string, label: string): Worker;
}

(self as typeof self & { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
	getWorker(_moduleId, label) {
		if (label === "json") return new JsonWorker();
		if (label === "css" || label === "scss" || label === "less") return new CssWorker();
		if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
		if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
		return new EditorWorker();
	},
};
