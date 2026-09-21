import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { ServerCapabilities, CompletionItem, CodeAction, Command } from "vscode-languageserver-protocol";
import {
	editorDiagnosticSchema,
	languageResponseSchemas,
	languageLimits,
	type EditorDocument,
	type LanguageCall,
	type LanguageCallResult,
	type LanguageConnection,
	type LanguageNotification,
	type EditorWorkspaceChange,
} from "@ling/contracts/editor-language";
import { resolveExistingProjectPath } from "../files/project-files";
import { createLanguageProcess, type LanguageProcess } from "./language-process";
import { resolveLanguageServer, type LanguageServerLaunch } from "./language-servers";
import { normalizeWorkspaceEdit } from "./workspace-edits";
import { toError, throwAggregateFailures } from "@ling/core/ling-error";

interface DocumentVersions {
	values: Map<string, number>;
	owners: Map<string, string>;
}
interface Ticket {
	method: "completionResolve" | "action";
	value: unknown;
	versions: DocumentVersions;
	bytes: number;
}
interface Connection {
	id: string;
	clientId: string;
	cwd: string;
	launch: LanguageServerLaunch;
	process: LanguageProcess;
	ready: Promise<void>;
	capabilities: ServerCapabilities;
	documents: Map<string, EditorDocument & { uri: string; owner: string }>;
	tickets: Map<string, Ticket>;
	ticketBytes: number;
	diagnostics: Map<string, z.infer<typeof editorDiagnosticSchema>[]>;
	closed: boolean;
	editCollector: { versions: DocumentVersions; changes: EditorWorkspaceChange[] } | null;
	actionQueue: Promise<void>;
}
const methods = {
	completion: "textDocument/completion",
	completionResolve: "completionItem/resolve",
	hover: "textDocument/hover",
	signature: "textDocument/signatureHelp",
	definition: "textDocument/definition",
	references: "textDocument/references",
	symbols: "textDocument/documentSymbol",
	workspaceSymbols: "workspace/symbol",
	rename: "textDocument/rename",
	format: "textDocument/formatting",
	rangeFormat: "textDocument/rangeFormatting",
	codeActions: "textDocument/codeAction",
	inlayHints: "textDocument/inlayHint",
	diagnostics: "textDocument/diagnostic",
	action: "workspace/executeCommand",
} as const;

export function createEditorLanguageService(options: {
	isTrusted(cwd: string): Promise<boolean>;
	onDiagnostics(clientId: string, value: LanguageNotification): void;
	onError(error: Error): void;
}) {
	const connections = new Map<string, Connection>();
	const starting = new Map<string, Promise<Connection>>();
	let disposed = false;
	function versions(connection: Connection): DocumentVersions {
		return {
			values: new Map([...connection.documents.values()].map((doc) => [doc.uri, doc.version])),
			owners: new Map([...connection.documents.values()].map((doc) => [doc.uri, doc.owner])),
		};
	}
	function assertVersions(connection: Connection, expected: DocumentVersions) {
		const current = new Map([...connection.documents.values()].map((doc) => [doc.uri, doc]));
		for (const [uri, version] of expected.values) {
			const doc = current.get(uri);
			if (!doc || doc.version !== version || doc.owner !== expected.owners.get(uri))
				throw new Error("The document changed while the language operation was running");
		}
	}
	function checkDocumentBudget(connection: Connection, incoming: EditorDocument) {
		let characters = incoming.text.length;
		for (const doc of connection.documents.values()) if (doc.path !== incoming.path) characters += doc.text.length;
		// Bound retained full-text mirrors to 16 MiB per project/server, not only the number of files.
		if (characters > 8 * 1_048_576) throw new Error("Open language documents exceed their memory budget");
	}
	async function stop(connection: Connection) {
		connection.closed = true;
		connections.delete(connection.id);
		connection.tickets.clear();
		connection.ticketBytes = 0;
		await connection.process.stop();
		connection.documents.clear();
		connection.diagnostics.clear();
	}
	async function start(clientId: string, cwd: string, launch: LanguageServerLaunch): Promise<Connection> {
		if (disposed) throw new Error("Editor language services are shutting down");
		// A client owns unsaved buffers. Different windows cannot share conflicting didChange streams.
		if (connections.size >= 16) throw new Error("Too many active project language services; close unused editors");
		const id = crypto.randomUUID();
		const connection: Connection = {
			id,
			clientId,
			cwd,
			launch,
			process: null as unknown as LanguageProcess,
			ready: Promise.resolve(),
			capabilities: {},
			documents: new Map(),
			tickets: new Map(),
			ticketBytes: 0,
			diagnostics: new Map(),
			closed: false,
			editCollector: null,
			actionQueue: Promise.resolve(),
		};
		connection.process = createLanguageProcess({
			...launch,
			cwd,
			onFailure(error) {
				if (connection.closed) return;
				for (const doc of connection.documents.values())
					options.onDiagnostics(clientId, {
						id,
						path: doc.path,
						version: doc.version,
						diagnostics: [],
						error: error.message,
					});
				connection.closed = true;
				connections.delete(id);
				options.onError(error);
				connection.documents.clear();
				connection.tickets.clear();
				connection.ticketBytes = 0;
				connection.diagnostics.clear();
			},
			onNotification(method, value) {
				if (method !== "textDocument/publishDiagnostics" || connection.closed) return;
				const result = z
					.object({
						uri: z.string(),
						version: z.number().optional(),
						diagnostics: z.array(editorDiagnosticSchema).max(languageLimits.items),
					})
					.parse(value);
				const doc = [...connection.documents.values()].find((doc) => doc.uri === result.uri);
				if (!doc || (result.version !== undefined && result.version !== doc.version)) return;
				connection.diagnostics.set(doc.uri, result.diagnostics);
				options.onDiagnostics(clientId, {
					id,
					path: doc.path,
					version: doc.version,
					diagnostics: result.diagnostics,
					error: null,
				});
			},
			async onRequest(method, value) {
				if (method === "workspace/configuration") {
					const request = z
						.object({ items: z.array(z.object({ section: z.string().optional() })).max(100) })
						.parse(value);
					return request.items.map((item) =>
						item.section?.endsWith("inlayHints")
							? {
									parameterNames: { enabled: "literals" },
									variableTypes: { enabled: true },
									functionLikeReturnTypes: { enabled: true },
								}
							: {},
					);
				}
				if (method === "workspace/workspaceFolders") return [{ uri: pathToFileURL(cwd).href, name: cwd }];
				if (
					method === "client/registerCapability" ||
					method === "client/unregisterCapability" ||
					method.endsWith("/refresh")
				)
					return null;
				if (method === "workspace/applyEdit") {
					// Commands only collect a proposal; the renderer reviews it and applies it through its document owner.
					const request = z.object({ edit: z.json(), label: z.string().optional() }).parse(value);
					const collector = connection.editCollector;
					if (!collector) return { applied: false, failureReason: "No editor action owns this edit" };
					const edit = await normalizeWorkspaceEdit(
						cwd,
						request.edit,
						collector.versions.values,
						request.label ?? "Code action",
					);
					if (edit) collector.changes.push(edit);
					return { applied: false, failureReason: "Edit proposed for user review; it has not been applied yet" };
				}
				throw new Error(`Unsupported language server request: ${method}`);
			},
		});
		connections.set(id, connection);
		connection.ready = (async () => {
			const result = await connection.process.request("initialize", {
				processId: process.pid,
				rootUri: pathToFileURL(cwd).href,
				workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: cwd }],
				clientInfo: { name: "Ling", version: "1" },
				initializationOptions: launch.initializationOptions,
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					workspace: {
						configuration: true,
						workspaceFolders: true,
						applyEdit: true,
						workspaceEdit: { documentChanges: true, failureHandling: "abort" },
						symbol: { resolveSupport: { properties: [] } },
					},
					textDocument: {
						synchronization: { didSave: true },
						completion: {
							completionItem: {
								snippetSupport: true,
								documentationFormat: ["markdown", "plaintext"],
								resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
							},
						},
						hover: { contentFormat: ["markdown", "plaintext"] },
						signatureHelp: {
							signatureInformation: {
								documentationFormat: ["markdown", "plaintext"],
								parameterInformation: { labelOffsetSupport: true },
							},
						},
						definition: { linkSupport: true },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						codeAction: {
							codeActionLiteralSupport: {
								codeActionKind: {
									valueSet: ["quickfix", "refactor", "source", "source.organizeImports", "source.fixAll"],
								},
							},
							resolveSupport: { properties: ["edit"] },
						},
						diagnostic: {},
						inlayHint: {},
						publishDiagnostics: { versionSupport: true },
					},
				},
			});
			const initialized = z.object({ capabilities: z.record(z.string(), z.json()) }).parse(result);
			connection.capabilities = initialized.capabilities as ServerCapabilities;
			if (connection.capabilities.positionEncoding && connection.capabilities.positionEncoding !== "utf-16")
				throw new Error("Language server must support UTF-16 positions");
			await connection.process.notify("initialized", {});
		})();
		try {
			await connection.ready;
			return connection;
		} catch (error) {
			await stop(connection);
			throw error;
		}
	}
	async function requireConnection(clientId: string, id: string) {
		const connection = connections.get(id);
		if (!connection || connection.clientId !== clientId || connection.closed)
			throw new Error("Editor language connection is no longer available");
		if (disposed) throw new Error("Editor language services are shutting down");
		await connection.ready;
		return connection;
	}
	function ticket(
		connection: Connection,
		method: Ticket["method"],
		value: unknown,
		captured: DocumentVersions,
	): string {
		const id = crypto.randomUUID();
		const bytes = Buffer.byteLength(JSON.stringify(value));
		connection.tickets.set(id, { method, value, versions: captured, bytes });
		connection.ticketBytes += bytes;
		// A count alone would retain thousands of large completion or refactoring payloads.
		while (connection.tickets.size > languageLimits.tickets || connection.ticketBytes > languageLimits.responseBytes) {
			const first = connection.tickets.entries().next().value!;
			connection.ticketBytes -= first[1].bytes;
			connection.tickets.delete(first[0]);
		}
		return id;
	}
	async function call(clientId: string, input: LanguageCall, signal: AbortSignal): Promise<LanguageCallResult> {
		const connection = await requireConnection(clientId, input.id);
		const doc = connection.documents.get(input.path);
		if (!doc || doc.version !== input.version) throw new Error("The language document version is stale");
		const captured = versions(connection);
		const params: Record<string, unknown> = { textDocument: { uri: doc.uri } };
		if (["completion", "hover", "signature", "definition", "references", "rename"].includes(input.method)) {
			if (!input.position) throw new Error("This language operation requires a position");
			params.position = input.position;
		}
		if (["rangeFormat", "codeActions", "inlayHints"].includes(input.method)) {
			if (!input.range) throw new Error("This language operation requires a range");
			params.range = input.range;
		}
		if (input.method === "completion")
			params.context = {
				triggerKind: input.triggerCharacter ? 2 : 1,
				...(input.triggerCharacter ? { triggerCharacter: input.triggerCharacter } : {}),
			};
		if (input.method === "references") params.context = { includeDeclaration: true };
		if (input.method === "codeActions")
			params.context = { diagnostics: connection.diagnostics.get(doc.uri) ?? [], triggerKind: 1 };
		if (input.method === "workspaceSymbols") {
			delete params.textDocument;
			params.query = input.query ?? "";
		}
		if (input.method === "rename") {
			if (!input.newName) throw new Error("A new name is required");
			params.newName = input.newName;
		}
		if (input.method === "format" || input.method === "rangeFormat") {
			if (!input.formatting) throw new Error("Formatting options are required");
			params.options = input.formatting;
		}
		let raw: unknown;
		if (input.method === "completionResolve" || input.method === "action") {
			const item = input.ticket ? connection.tickets.get(input.ticket) : undefined;
			if (!item || item.method !== input.method) throw new Error("Language action expired; request it again");
			assertVersions(connection, item.versions);
			if (input.method === "completionResolve")
				raw = await connection.process.request(methods.completionResolve, item.value, signal, input.requestId);
			else {
				let change: EditorWorkspaceChange | null = null;
				const action = async () => {
					assertVersions(connection, item.versions);
					signal.throwIfAborted();
					let value = item.value as CodeAction | Command;
					if (
						!(typeof value.command === "string") &&
						!(value as CodeAction).edit &&
						!value.command &&
						(value as CodeAction).data !== undefined
					) {
						const resolved = languageResponseSchemas.codeActions.parse([
							await connection.process.request("codeAction/resolve", value, signal),
						]);
						value = resolved![0] as CodeAction;
					}
					if ("edit" in value && value.edit)
						change = await normalizeWorkspaceEdit(connection.cwd, value.edit, item.versions.values, value.title);
					const command = typeof value.command === "string" ? (value as Command) : value.command;
					if (command) {
						const collector = { versions: item.versions, changes: [] as EditorWorkspaceChange[] };
						connection.editCollector = collector;
						try {
							await connection.process.request(
								methods.action,
								{ command: command.command, arguments: command.arguments ?? [] },
								signal,
								input.requestId,
							);
						} finally {
							connection.editCollector = null;
						}
						const files = [...(change?.files ?? []), ...collector.changes.flatMap((edit) => edit.files)];
						if (files.length) change = { label: value.title, files };
					}
				};
				const operation = connection.actionQueue.then(action);
				connection.actionQueue = operation.then(
					() => {},
					() => {},
				);
				await operation;
				assertVersions(connection, captured);
				return { data: null, change };
			}
		} else raw = await connection.process.request(methods[input.method], params, signal, input.requestId);
		assertVersions(connection, captured);
		signal.throwIfAborted();
		if (JSON.stringify(raw).length > languageLimits.responseBytes)
			throw new Error("Language response exceeds its budget");
		const data = languageResponseSchemas[input.method].parse(raw);
		if (input.method === "rename")
			return {
				data: null,
				change: await normalizeWorkspaceEdit(connection.cwd, data, captured.values, input.newName!),
			};
		if (input.method === "completion" && data) {
			const response = data as CompletionItem[] | { items: CompletionItem[] };
			for (const item of Array.isArray(response) ? response : response.items)
				(item as CompletionItem & { lingTicket: string }).lingTicket = ticket(
					connection,
					"completionResolve",
					{ ...item },
					captured,
				);
		}
		if (input.method === "codeActions" && Array.isArray(data))
			for (const item of data)
				(item as unknown as { lingTicket: string }).lingTicket = ticket(
					connection,
					"action",
					{ ...(item as CodeAction | Command) },
					captured,
				);
		if (input.method === "diagnostics" && data && typeof data === "object" && "items" in data)
			connection.diagnostics.set(doc.uri, (data.items ?? []) as z.infer<typeof editorDiagnosticSchema>[]);
		return { data, change: null };
	}
	return {
		async save(clientId: string, id: string, path: string, savedText: string) {
			const connection = await requireConnection(clientId, id),
				doc = connection.documents.get(path);
			if (!doc) throw new Error("The saved language document is no longer open");
			const sync = connection.capabilities.textDocumentSync;
			if (sync && typeof sync === "object" && sync.save)
				await connection.process.notify("textDocument/didSave", {
					textDocument: { uri: doc.uri },
					// Typing may have advanced didChange while the disk write was in flight.
					...(typeof sync.save === "object" && sync.save.includeText ? { text: savedText } : {}),
				});
		},
		cwd(clientId: string, id: string) {
			const item = connections.get(id);
			if (!item || item.clientId !== clientId) throw new Error("Unknown editor connection");
			return item.cwd;
		},
		async open(clientId: string, doc: EditorDocument, signal: AbortSignal): Promise<LanguageConnection | null> {
			const uri = pathToFileURL(await resolveExistingProjectPath(doc.cwd, doc.path)).href;
			const launch = await resolveLanguageServer(doc.cwd, doc.language, await options.isTrusted(doc.cwd));
			if (!launch) return null;
			signal.throwIfAborted();
			const key = `${clientId}\0${doc.cwd}\0${launch.id}`;
			let connection = [...connections.values()].find(
				(item) => item.clientId === clientId && item.cwd === doc.cwd && item.launch.id === launch.id && !item.closed,
			);
			if (connection && connection.launch.revision !== launch.revision) {
				await stop(connection);
				connection = undefined;
			}
			if (!connection) {
				let pending = starting.get(key);
				if (!pending) {
					pending = start(clientId, doc.cwd, launch);
					starting.set(key, pending);
				}
				try {
					connection = await pending;
				} finally {
					if (starting.get(key) === pending) starting.delete(key);
				}
			}
			await connection.ready;
			if (signal.aborted) {
				if (connection.documents.size === 0) await stop(connection);
				signal.throwIfAborted();
			}
			if (connection.closed || disposed) throw new Error("Language connection closed during initialization");
			const previous = connection.documents.get(doc.path);
			if (previous) {
				if (previous.version !== doc.version || previous.text !== doc.text)
					throw new Error("The document already has a different language owner");
			} else {
				if (connection.documents.size >= 128) throw new Error("Too many open language documents");
				checkDocumentBudget(connection, doc);
				connection.documents.set(doc.path, { ...doc, uri, owner: crypto.randomUUID() });
				await connection.process.notify("textDocument/didOpen", {
					textDocument: { uri, languageId: doc.language, version: doc.version, text: doc.text },
				});
			}
			return { id: connection.id, name: launch.name, capabilities: connection.capabilities };
		},
		async change(clientId: string, id: string, doc: EditorDocument) {
			const connection = await requireConnection(clientId, id),
				previous = connection.documents.get(doc.path);
			if (!previous || doc.cwd !== connection.cwd || doc.version <= previous.version)
				throw new Error("Stale language document update");
			checkDocumentBudget(connection, doc);
			connection.documents.set(doc.path, { ...doc, uri: previous.uri, owner: previous.owner });
			await connection.process.notify("textDocument/didChange", {
				textDocument: { uri: previous.uri, version: doc.version },
				contentChanges: [{ text: doc.text }],
			});
		},
		async close(clientId: string, id: string, path: string) {
			const connection = connections.get(id);
			if (!connection || connection.clientId !== clientId) return;
			const doc = connection.documents.get(path);
			if (!doc) return;
			connection.documents.delete(path);
			connection.diagnostics.delete(doc.uri);
			await connection.process.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
			if (connection.documents.size === 0) await stop(connection);
		},
		call,
		async cancel(clientId: string, id: string, requestId: string) {
			const connection = await requireConnection(clientId, id);
			connection.process.cancel(requestId);
		},
		async releaseClient(clientId: string) {
			// A new page may open immediately while the previous page's initialization is still draining.
			for (const key of starting.keys()) if (key.startsWith(`${clientId}\0`)) starting.delete(key);
			const result = await Promise.allSettled(
				[...connections.values()].filter((item) => item.clientId === clientId).map(stop),
			);
			throwAggregateFailures(
				result.flatMap((item) => (item.status === "rejected" ? [item.reason] : [])),
				"Language client cleanup failed",
			);
		},
		async closeProject(cwd: string) {
			const result = await Promise.allSettled([...connections.values()].filter((item) => item.cwd === cwd).map(stop));
			throwAggregateFailures(
				result.flatMap((item) => (item.status === "rejected" ? [item.reason] : [])),
				"Language project cleanup failed",
			);
		},
		prepareShutdown() {
			disposed = true;
		},
		async dispose() {
			disposed = true;
			const results = await Promise.allSettled([...connections.values()].map(stop));
			await Promise.allSettled(starting.values());
			starting.clear();
			throwAggregateFailures(
				results.flatMap((item) => (item.status === "rejected" ? [toError(item.reason)] : [])),
				"Language shutdown failed",
			);
		},
	};
}
