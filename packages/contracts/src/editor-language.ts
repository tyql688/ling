import { z } from "zod";
import type * as Lsp from "vscode-languageserver-protocol";
import { createProjectFileSchemas } from "./project-file-requests";
import { portableAbsolutePathSchema } from "./path-validation";

/** A document fits the existing text preview budget; responses and retained tickets have separate limits. */
export const languageLimits = {
	text: 2_000_000,
	responseBytes: 4 * 1_048_576,
	items: 10_000,
	tickets: 2_000,
	editFiles: 50,
} as const;
const editorPositionSchema = z.object({
	line: z.number().int().nonnegative(),
	character: z.number().int().nonnegative(),
});
export const editorRangeSchema = z
	.object({ start: editorPositionSchema, end: editorPositionSchema })
	.refine(
		({ start, end }) => start.line < end.line || (start.line === end.line && start.character <= end.character),
		"The range must end after its start",
	);
export const editorTextEditSchema = z.object({
	range: editorRangeSchema,
	newText: z.string().max(languageLimits.text),
});
export const editorDiagnosticSchema = z.object({
	range: editorRangeSchema,
	message: z.string().max(100_000),
	severity: z.number().int().min(1).max(4).optional(),
	code: z.union([z.string(), z.number()]).optional(),
	source: z.string().optional(),
	tags: z.array(z.number().int().min(1).max(2)).optional(),
});
const text = z.string().max(languageLimits.text);
const marked = z.union([
	text,
	z.object({ kind: z.enum(["plaintext", "markdown"]), value: text }),
	z.object({ language: z.string(), value: text }),
]);
const location = z.object({ uri: z.string(), range: editorRangeSchema });
const locationLink = z.object({
	targetUri: z.string(),
	targetRange: editorRangeSchema,
	targetSelectionRange: editorRangeSchema,
	originSelectionRange: editorRangeSchema.optional(),
});
const command = z.object({ title: z.string(), command: z.string(), arguments: z.array(z.json()).optional() });
const completionItem = z
	.object({
		label: z.string(),
		kind: z.number().int().min(1).max(25).optional(),
		detail: z.string().optional(),
		documentation: marked.optional(),
		sortText: z.string().optional(),
		filterText: z.string().optional(),
		insertText: z.string().optional(),
		insertTextFormat: z.number().int().min(1).max(2).optional(),
		textEdit: z
			.union([editorTextEditSchema, z.object({ newText: text, insert: editorRangeSchema, replace: editorRangeSchema })])
			.optional(),
		additionalTextEdits: z.array(editorTextEditSchema).max(languageLimits.items).optional(),
		data: z.json().optional(),
		tags: z.array(z.number()).optional(),
	})
	.loose();
interface ParsedSymbol {
	name: string;
	detail?: string | undefined;
	kind: number;
	range: Lsp.Range;
	selectionRange: Lsp.Range;
	children?: ParsedSymbol[] | undefined;
}
const symbol: z.ZodType<ParsedSymbol> = z.lazy(() =>
	z.object({
		name: z.string(),
		detail: z.string().optional(),
		kind: z.number().int().min(1).max(26),
		range: editorRangeSchema,
		selectionRange: editorRangeSchema,
		children: z.array(symbol).max(languageLimits.items).optional(),
	}),
);
const symbolInformation = z.object({
	name: z.string(),
	kind: z.number().int().min(1).max(26),
	location,
	containerName: z.string().optional(),
});
const action = z
	.object({
		title: z.string(),
		kind: z.string().optional(),
		diagnostics: z.array(editorDiagnosticSchema).optional(),
		isPreferred: z.boolean().optional(),
		disabled: z.object({ reason: z.string() }).optional(),
		edit: z.json().optional(),
		command: z.union([command, z.string()]).optional(),
		arguments: z.array(z.json()).optional(),
		data: z.json().optional(),
	})
	.loose();
const array = <T extends z.ZodType>(item: T) => z.array(item).max(languageLimits.items);
export const languageResponseSchemas = {
	completion: z
		.union([
			array(completionItem),
			z.object({ isIncomplete: z.boolean(), items: array(completionItem), itemDefaults: z.json().optional() }),
		])
		.nullable(),
	completionResolve: completionItem,
	hover: z.object({ contents: z.union([marked, array(marked)]), range: editorRangeSchema.optional() }).nullable(),
	signature: z
		.object({
			signatures: array(
				z.object({
					label: z.string(),
					documentation: marked.optional(),
					parameters: array(
						z.object({
							label: z.union([z.string(), z.tuple([z.number(), z.number()])]),
							documentation: marked.optional(),
						}),
					).optional(),
					activeParameter: z.number().int().nonnegative().optional(),
				}),
			),
			activeSignature: z.number().int().nonnegative().optional(),
			activeParameter: z.number().int().nonnegative().optional(),
		})
		.nullable(),
	definition: z.union([location, array(z.union([location, locationLink]))]).nullable(),
	references: array(location).nullable(),
	symbols: array(z.union([symbol, symbolInformation])).nullable(),
	workspaceSymbols: array(symbolInformation).nullable(),
	rename: z.json(),
	format: array(editorTextEditSchema).nullable(),
	rangeFormat: array(editorTextEditSchema).nullable(),
	codeActions: array(action).nullable(),
	action: z.json(),
	inlayHints: array(
		z.object({
			position: editorPositionSchema,
			label: z.union([z.string(), array(z.object({ value: z.string(), tooltip: marked.optional() }))]),
			kind: z.number().int().min(1).max(2).optional(),
			paddingLeft: z.boolean().optional(),
			paddingRight: z.boolean().optional(),
			tooltip: marked.optional(),
			textEdits: array(editorTextEditSchema).optional(),
		}),
	).nullable(),
	diagnostics: z.object({
		kind: z.enum(["full", "unchanged"]),
		items: array(editorDiagnosticSchema).optional(),
		resultId: z.string().optional(),
	}),
};
export type LanguageMethod = keyof typeof languageResponseSchemas;
const languageMethodSchema = z.enum(Object.keys(languageResponseSchemas) as [LanguageMethod, ...LanguageMethod[]]);
export type LanguageResults = {
	completion: Lsp.CompletionItem[] | Lsp.CompletionList | null;
	completionResolve: Lsp.CompletionItem;
	hover: Lsp.Hover | null;
	signature: Lsp.SignatureHelp | null;
	definition: Lsp.Location | Array<Lsp.Location | Lsp.LocationLink> | null;
	references: Lsp.Location[] | null;
	symbols: Array<Lsp.DocumentSymbol | Lsp.SymbolInformation> | null;
	workspaceSymbols: Lsp.SymbolInformation[] | null;
	rename: Lsp.WorkspaceEdit | null;
	format: Lsp.TextEdit[] | null;
	rangeFormat: Lsp.TextEdit[] | null;
	codeActions: Array<Lsp.CodeAction | Lsp.Command> | null;
	action: Lsp.WorkspaceEdit | null;
	inlayHints: Lsp.InlayHint[] | null;
	diagnostics: Lsp.DocumentDiagnosticReport;
};
export type { Range, TextEdit, ServerCapabilities } from "vscode-languageserver-protocol";

const id = z.string().min(1).max(200);
const projectFiles = createProjectFileSchemas();
export const editorDocumentSchema = z.strictObject({
	cwd: portableAbsolutePathSchema("Project path"),
	path: projectFiles.projectFileReferencePathSchema,
	language: id,
	version: z.number().int().positive(),
	text,
});
export const languageCallSchema = z.strictObject({
	id,
	requestId: id,
	path: z.string().min(1).max(4_096),
	version: z.number().int().positive(),
	method: languageMethodSchema,
	position: editorPositionSchema.optional(),
	range: editorRangeSchema.optional(),
	query: z.string().max(1_000).optional(),
	newName: z.string().min(1).max(1_000).optional(),
	ticket: id.optional(),
	formatting: z.object({ tabSize: z.number().int().min(1).max(16), insertSpaces: z.boolean() }).optional(),
	triggerCharacter: z.string().max(8).optional(),
});
export type EditorDocument = z.infer<typeof editorDocumentSchema>;
export type LanguageCall = z.infer<typeof languageCallSchema>;
export interface LanguageConnection {
	id: string;
	name: string;
	capabilities: Lsp.ServerCapabilities;
}
export interface LanguageNotification {
	id: string;
	path: string;
	version: number;
	diagnostics: z.infer<typeof editorDiagnosticSchema>[];
	error: string | null;
	reconnect?: boolean;
}
interface EditorFileChange {
	path: string;
	version: number | null;
	baseRevision?: string;
	edits: Lsp.TextEdit[];
}
export interface EditorWorkspaceChange {
	label: string;
	files: EditorFileChange[];
}
export interface LanguageCallResult {
	data: unknown;
	change: EditorWorkspaceChange | null;
}
