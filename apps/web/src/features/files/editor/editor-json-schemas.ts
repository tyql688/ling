import { json } from "monaco-editor";
import { editorJsonSchemas } from "@ling/contracts/editor-json-schemas";

/** JSON editing validates files against the same schemas their runtime owners load them with. */
export function configureEditorJsonSchemas(): void {
	json.jsonDefaults.setDiagnosticsOptions({
		validate: true,
		allowComments: true,
		enableSchemaRequest: false,
		schemas: editorJsonSchemas(),
	});
}
