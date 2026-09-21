import * as monaco from "monaco-editor";
import type { EditorLanguageClient, EditorLanguageDocument } from "./editor-language-client";
import { editorRange, languageRange, languagePosition } from "./editor-coordinates";
import { modelUri } from "./monaco-documents";
import type { LanguageResults, ServerCapabilities } from "@ling/contracts/editor-language";

function markdown(value: unknown): monaco.IMarkdownString {
	if (typeof value === "string") return { value, isTrusted: false, supportHtml: false };
	if (value && typeof value === "object" && "value" in value)
		return { value: String(value.value), isTrusted: false, supportHtml: false };
	return { value: "" };
}
function completionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
	const names = [
		"Text",
		"Method",
		"Function",
		"Constructor",
		"Field",
		"Variable",
		"Class",
		"Interface",
		"Module",
		"Property",
		"Unit",
		"Value",
		"Enum",
		"Keyword",
		"Snippet",
		"Color",
		"File",
		"Reference",
		"Folder",
		"EnumMember",
		"Constant",
		"Struct",
		"Event",
		"Operator",
		"TypeParameter",
	] as const;
	return monaco.languages.CompletionItemKind[names[(kind ?? 1) - 1] ?? "Text"];
}
function item(value: LanguageResults["completionResolve"], model: monaco.editor.ITextModel, position: monaco.Position) {
	const word = model.getWordUntilPosition(position),
		edit = value.textEdit;
	const range = edit
		? "range" in edit
			? editorRange(edit.range)
			: { insert: editorRange(edit.insert), replace: editorRange(edit.replace) }
		: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
	return {
		label: value.label,
		kind: completionKind(value.kind),
		range,
		insertText: edit?.newText ?? value.insertText ?? value.label,
		...(value.detail === undefined ? {} : { detail: value.detail }),
		...(value.documentation === undefined ? {} : { documentation: markdown(value.documentation) }),
		...(value.sortText === undefined ? {} : { sortText: value.sortText }),
		...(value.filterText === undefined ? {} : { filterText: value.filterText }),
		...(value.insertTextFormat === 2
			? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
			: {}),
		...(value.additionalTextEdits
			? {
					additionalTextEdits: value.additionalTextEdits.map((edit) => ({
						range: editorRange(edit.range),
						text: edit.newText,
					})),
				}
			: {}),
		lingTicket: (value as { lingTicket?: string }).lingTicket,
		lingModel: model,
		lingPosition: position,
	} satisfies monaco.languages.CompletionItem & {
		lingTicket: string | undefined;
		lingModel: monaco.editor.ITextModel;
		lingPosition: monaco.Position;
	};
}
export async function runLanguageAction(
	client: EditorLanguageClient,
	doc: EditorLanguageDocument,
	ticket: string,
): Promise<void> {
	const result = await client.request(doc, "action", { ticket });
	if (!result?.change) return;
	const view = [...client.views].find(([editor]) => editor.getModel() === doc.model)?.[1];
	if (view) await view.propose(result.change);
}

export function registerLanguageProviders(client: EditorLanguageClient): monaco.IDisposable {
	const selector = { scheme: "ling-project" };
	const registrations: monaco.IDisposable[] = [];
	async function document(model: monaco.editor.ITextModel, capability: keyof ServerCapabilities) {
		const doc = client.get(model);
		if (!doc) return null;
		await doc.ready;
		return !doc.disposed && doc.connection?.capabilities[capability] ? doc : null;
	}
	registrations.push(
		monaco.languages.registerCompletionItemProvider(selector, {
			triggerCharacters: [".", '"', "'", "/", "@", "<", "#"],
			async provideCompletionItems(model, position, context, token) {
				const doc = await document(model, "completionProvider");
				if (!doc) return undefined;
				const result = await client.request(
					doc,
					"completion",
					{
						position: languagePosition(position),
						...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
					},
					token,
				);
				if (!result?.data) return undefined;
				return {
					suggestions: (Array.isArray(result.data) ? result.data : result.data.items).map((value) =>
						item(value, model, position),
					),
					incomplete: !Array.isArray(result.data) && result.data.isIncomplete,
				};
			},
			async resolveCompletionItem(value, token) {
				const entry = value as ReturnType<typeof item>,
					doc = client.get(entry.lingModel);
				if (!doc || !entry.lingTicket || !doc.connection?.capabilities.completionProvider?.resolveProvider)
					return value;
				const result = await client.request(doc, "completionResolve", { ticket: entry.lingTicket }, token);
				return result ? { ...value, ...item(result.data, entry.lingModel, entry.lingPosition) } : value;
			},
		}),
	);
	registrations.push(
		monaco.languages.registerHoverProvider(selector, {
			async provideHover(model, position, token) {
				const doc = await document(model, "hoverProvider");
				if (!doc) return undefined;
				const result = await client.request(doc, "hover", { position: languagePosition(position) }, token);
				if (!result?.data) return undefined;
				return {
					contents: (Array.isArray(result.data.contents) ? result.data.contents : [result.data.contents]).map(markdown),
					...(result.data.range ? { range: editorRange(result.data.range) } : {}),
				};
			},
		}),
	);
	registrations.push(
		monaco.languages.registerSignatureHelpProvider(selector, {
			signatureHelpTriggerCharacters: ["(", ",", "<"],
			signatureHelpRetriggerCharacters: [")"],
			async provideSignatureHelp(model, position, token) {
				const doc = await document(model, "signatureHelpProvider");
				if (!doc) return undefined;
				const result = await client.request(doc, "signature", { position: languagePosition(position) }, token);
				if (!result?.data) return undefined;
				return {
					value: {
						signatures: result.data.signatures.map((signature) => ({
							label: signature.label,
							documentation: markdown(signature.documentation),
							parameters: (signature.parameters ?? []).map((parameter) => ({
								label: parameter.label,
								documentation: markdown(parameter.documentation),
							})),
						})),
						activeSignature: result.data.activeSignature ?? 0,
						activeParameter: result.data.activeParameter ?? 0,
					},
					dispose() {},
				};
			},
		}),
	);
	registrations.push(
		monaco.languages.registerDefinitionProvider(selector, {
			async provideDefinition(model, position, token) {
				const doc = await document(model, "definitionProvider");
				if (!doc) return undefined;
				const result = await client.request(doc, "definition", { position: languagePosition(position) }, token);
				if (!result?.data) return undefined;
				const locations = Array.isArray(result.data) ? result.data : [result.data];
				const loaded = await client.loadLocations(
					doc,
					locations.map((value) => ("targetUri" in value ? value.targetUri : value.uri)),
				);
				try {
					return locations
						.filter((value) => loaded.has("targetUri" in value ? value.targetUri : value.uri))
						.map((value) =>
							"targetUri" in value
								? {
										uri: client.uri(doc, value.targetUri),
										range: editorRange(value.targetRange),
										targetSelectionRange: editorRange(value.targetSelectionRange),
										...(value.originSelectionRange
											? { originSelectionRange: editorRange(value.originSelectionRange) }
											: {}),
									}
								: { uri: client.uri(doc, value.uri), range: editorRange(value.range) },
						);
				} catch (error) {
					client.report(doc, error);
					return undefined;
				}
			},
		}),
	);
	registrations.push(
		monaco.languages.registerReferenceProvider(selector, {
			async provideReferences(model, position, _context, token) {
				const doc = await document(model, "referencesProvider");
				if (!doc) return undefined;
				const result = await client.request(doc, "references", { position: languagePosition(position) }, token);
				const loaded = await client.loadLocations(
					doc,
					(result?.data ?? []).map((value) => value.uri),
				);
				try {
					return result?.data
						?.filter((value) => loaded.has(value.uri))
						.map((value) => ({ uri: client.uri(doc, value.uri), range: editorRange(value.range) }));
				} catch (error) {
					client.report(doc, error);
					return undefined;
				}
			},
		}),
	);
	registrations.push(
		monaco.languages.registerDocumentSymbolProvider(selector, {
			async provideDocumentSymbols(model, token) {
				const doc = await document(model, "documentSymbolProvider");
				if (!doc) return undefined;
				const result = await client.request(doc, "symbols", {}, token);
				function symbol(value: NonNullable<LanguageResults["symbols"]>[number]): monaco.languages.DocumentSymbol {
					const range = "location" in value ? value.location.range : value.range;
					return {
						name: value.name,
						detail: "detail" in value ? (value.detail ?? "") : "",
						kind: value.kind - 1,
						tags: [],
						range: editorRange(range),
						selectionRange: editorRange("selectionRange" in value ? value.selectionRange : range),
						children: "children" in value ? (value.children?.map(symbol) ?? []) : [],
					};
				}
				return result?.data?.map(symbol);
			},
		}),
	);
	registrations.push(
		monaco.languages.registerDocumentFormattingEditProvider(selector, {
			displayName: "Project language service",
			async provideDocumentFormattingEdits(model, options, token) {
				const doc = client.get(model);
				if (!doc) return undefined;
				try {
					const formatted = await client.format(doc);
					if (formatted !== null)
						return formatted.map((edit) => ({ range: editorRange(edit.range), text: edit.newText }));
				} catch (error) {
					client.report(doc, error);
					return undefined;
				}
				if (!doc.connection?.capabilities.documentFormattingProvider) return undefined;
				const result = await client.request(doc, "format", { formatting: options }, token);
				return result?.data?.map((edit) => ({ range: editorRange(edit.range), text: edit.newText }));
			},
		}),
	);
	registrations.push(
		monaco.languages.registerDocumentRangeFormattingEditProvider(selector, {
			displayName: "Project language service",
			async provideDocumentRangeFormattingEdits(model, range, options, token) {
				const doc = client.get(model);
				if (!doc) return undefined;
				try {
					const formatted = await client.format(doc, languageRange(range));
					if (formatted !== null)
						return formatted.map((edit) => ({ range: editorRange(edit.range), text: edit.newText }));
				} catch (error) {
					client.report(doc, error);
					return undefined;
				}
				if (!doc.connection?.capabilities.documentRangeFormattingProvider) return undefined;
				const result = await client.request(
					doc,
					"rangeFormat",
					{ range: languageRange(range), formatting: options },
					token,
				);
				return result?.data?.map((edit) => ({ range: editorRange(edit.range), text: edit.newText }));
			},
		}),
	);
	registrations.push(
		monaco.languages.registerRenameProvider(selector, {
			async provideRenameEdits(model, position, newName, token) {
				const doc = await document(model, "renameProvider");
				if (!doc) return { edits: [], rejectReason: "Project rename is unavailable" };
				const result = await client.request(doc, "rename", { position: languagePosition(position), newName }, token);
				if (result?.change) {
					const view = [...client.views].find(([editor]) => editor.getModel() === model)?.[1];
					if (view) await view.propose(result.change);
				}
				return { edits: [] };
			},
		}),
	);
	registrations.push(
		monaco.editor.registerCommand("ling.language.action", (_accessor, uri: string, ticket: string) => {
			const doc = client.documents.get(uri);
			if (doc) void runLanguageAction(client, doc, ticket).catch((error) => client.report(doc, error));
		}),
	);
	registrations.push(
		monaco.languages.registerCodeActionProvider(selector, {
			async provideCodeActions(model, range, _context, token) {
				const doc = await document(model, "codeActionProvider");
				if (!doc) return undefined;
				const result = await client.request(doc, "codeActions", { range: languageRange(range) }, token);
				return {
					actions: (result?.data ?? []).map((value) => ({
						title: value.title,
						...(typeof value.command !== "string" && "kind" in value && value.kind ? { kind: value.kind } : {}),
						...("disabled" in value && value.disabled ? { disabled: value.disabled.reason } : {}),
						command: {
							id: "ling.language.action",
							title: value.title,
							arguments: [model.uri.toString(), (value as { lingTicket?: string }).lingTicket],
						},
					})),
					dispose() {},
				};
			},
		}),
	);
	registrations.push(
		monaco.languages.registerInlayHintsProvider(selector, {
			async provideInlayHints(model, range, token) {
				const doc = await document(model, "inlayHintProvider");
				if (!doc) return undefined;
				const result = await client.request(doc, "inlayHints", { range: languageRange(range) }, token);
				return {
					hints: (result?.data ?? []).map((value) => ({
						position: { lineNumber: value.position.line + 1, column: value.position.character + 1 },
						label:
							typeof value.label === "string"
								? value.label
								: value.label.map((part) => ({
										label: part.value,
										...(part.tooltip ? { tooltip: markdown(part.tooltip) } : {}),
									})),
						...(value.kind ? { kind: value.kind } : {}),
						...(value.tooltip ? { tooltip: markdown(value.tooltip) } : {}),
						paddingLeft: value.paddingLeft ?? false,
						paddingRight: value.paddingRight ?? false,
					})),
					dispose() {},
				};
			},
		}),
	);
	registrations.push(
		monaco.editor.registerEditorOpener({
			openCodeEditor(source, resource, selection) {
				const model = source.getModel(),
					doc = model ? client.get(model) : null,
					view = client.views.get(source);
				if (!doc || !view || resource.scheme !== "ling-project") return false;
				const prefix = modelUri(doc.cwd, "").path;
				if (!resource.path.startsWith(prefix)) return false;
				const range = selection
					? "startLineNumber" in selection
						? selection
						: new monaco.Range(selection.lineNumber, selection.column, selection.lineNumber, selection.column)
					: undefined;
				view.open(resource.path.slice(prefix.length), range);
				return true;
			},
		}),
	);
	return {
		dispose() {
			for (const registration of registrations) registration.dispose();
		},
	};
}
