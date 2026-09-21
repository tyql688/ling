import { z } from "zod";
import { request, event, returns } from "./procedure";
import {
	editorDocumentSchema,
	editorRangeSchema,
	languageCallSchema,
	type LanguageConnection,
	type LanguageNotification,
	type LanguageCallResult,
	type TextEdit,
} from "./editor-language";
const close = z.strictObject({ id: z.string().min(1).max(200), path: z.string().min(1).max(4_096) });
const format = editorDocumentSchema.extend({ range: editorRangeSchema.optional() });
const save = close.extend({ text: editorDocumentSchema.shape.text });
export const editorLanguageProcedures = {
	save: request("editorLanguage:save", (args) => [save.parse(args[0])] as [z.infer<typeof save>], returns<void>()),
	format: request(
		"editorLanguage:format",
		(args) => [format.parse(args[0])] as [z.infer<typeof format>],
		returns<TextEdit[] | null>(),
	),
	open: request(
		"editorLanguage:open",
		(args) => [editorDocumentSchema.parse(args[0])] as [z.infer<typeof editorDocumentSchema>],
		returns<LanguageConnection | null>(),
	),
	change: request(
		"editorLanguage:change",
		(args) =>
			[editorDocumentSchema.extend({ id: z.string().min(1).max(200) }).parse(args[0])] as [
				z.infer<typeof editorDocumentSchema> & { id: string },
			],
		returns<void>(),
	),
	close: request("editorLanguage:close", (args) => [close.parse(args[0])] as [z.infer<typeof close>], returns<void>()),
	call: request(
		"editorLanguage:call",
		(args) => [languageCallSchema.parse(args[0])] as [z.infer<typeof languageCallSchema>],
		returns<LanguageCallResult>(),
	),
	cancel: request(
		"editorLanguage:cancel",
		(args) =>
			[z.object({ id: z.string(), requestId: z.string() }).parse(args[0])] as [{ id: string; requestId: string }],
		returns<void>(),
	),
	onDiagnostics: event("editorLanguage:diagnostics", returns<LanguageNotification>()),
};
