import * as monaco from "monaco-editor";
import type { LingApi } from "@ling/contracts/api/ling-api";
import type {
	LanguageCall,
	LanguageConnection,
	LanguageMethod,
	LanguageResults,
	EditorWorkspaceChange,
	Range,
} from "@ling/contracts/editor-language";
import { formatRequestError } from "@renderer/lib/errors";
import { registerLanguageProviders } from "./editor-language-providers";
import { modelUri, onModelSaved, modelRecords, trimModelRecords, type MonacoModelRecord } from "./monaco-documents";
import { editorRange, projectLanguagePath } from "./editor-coordinates";

export interface EditorLanguageDocument {
	model: monaco.editor.ITextModel;
	cwd: string;
	path: string;
	connection: LanguageConnection | null;
	error: string | null;
	ready: Promise<void>;
	version: number;
	disposed: boolean;
	generation: number;
	sync: Promise<void>;
	timer: ReturnType<typeof setTimeout> | null;
	diagnosticToken: monaco.CancellationTokenSource | null;
	owners: number;
	releases: monaco.IDisposable[];
}
interface EditorLanguageView {
	open(path: string, range?: monaco.IRange): void;
	load(path: string): Promise<monaco.editor.ITextModel>;
	propose(change: EditorWorkspaceChange): Promise<boolean>;
}
const clients = new WeakMap<LingApi["editorLanguage"], ReturnType<typeof createEditorLanguageClient>>();
export function getEditorLanguageClient(api: LingApi["editorLanguage"]) {
	let client = clients.get(api);
	if (!client) {
		client = createEditorLanguageClient(api);
		clients.set(api, client);
	}
	return client;
}
function createEditorLanguageClient(api: LingApi["editorLanguage"]) {
	const documents = new Map<string, EditorLanguageDocument>();
	const closing = new Map<string, Promise<void>>();
	const views = new Map<monaco.editor.ICodeEditor, EditorLanguageView>();
	const references = new Map<EditorLanguageView, Set<MonacoModelRecord>>();
	function releaseReferences(view: EditorLanguageView) {
		for (const record of references.get(view) ?? []) record.activeEditors--;
		references.delete(view);
		trimModelRecords();
	}
	const listeners = new Set<() => void>();
	let revision = 0;
	const notify = () => {
		revision++;
		for (const listener of listeners) listener();
	};
	const setError = (doc: EditorLanguageDocument, error: unknown) => {
		if (doc.disposed) return;
		doc.error = formatRequestError(error);
		monaco.editor.setModelMarkers(doc.model, "ling-language", []);
		notify();
	};
	const snapshot = (doc: EditorLanguageDocument) => ({
		cwd: doc.cwd,
		path: doc.path,
		language: doc.model.getLanguageId(),
		version: doc.model.getVersionId(),
		text: doc.model.getValue(),
	});
	async function start(doc: EditorLanguageDocument) {
		const generation = ++doc.generation,
			current = snapshot(doc);
		doc.error = null;
		try {
			await closing.get(doc.model.uri.toString());
			if (doc.disposed || generation !== doc.generation) return;
			const connection = await api.open(current);
			if (doc.disposed || doc.generation !== generation) {
				if (connection) await api.close({ id: connection.id, path: doc.path });
				return;
			}
			doc.connection = connection;
			doc.version = current.version;
			notify();
		} catch (error) {
			if (doc.generation === generation) setError(doc, error);
		}
	}
	async function flush(doc: EditorLanguageDocument): Promise<void> {
		await doc.ready;
		const generation = doc.generation;
		const update = async () => {
			while (!doc.disposed && doc.connection && doc.version !== doc.model.getVersionId()) {
				const value = snapshot(doc),
					id = doc.connection.id;
				await api.change({ ...value, id });
				if (doc.connection?.id !== id) return;
				doc.version = value.version;
			}
		};
		const result = doc.sync.then(update);
		doc.sync = result.catch((error) => {
			if (doc.generation === generation) setError(doc, error);
		});
		await result;
	}
	async function request<M extends LanguageMethod>(
		doc: EditorLanguageDocument,
		method: M,
		params: Partial<LanguageCall> = {},
		token?: monaco.CancellationToken,
	): Promise<{ data: LanguageResults[M]; change: EditorWorkspaceChange | null } | null> {
		const generation = doc.generation;
		try {
			await flush(doc);
			if (doc.disposed || !doc.connection || token?.isCancellationRequested) return null;
			const id = doc.connection.id,
				requestId = crypto.randomUUID(),
				version = doc.model.getVersionId();
			const cancelled = token?.onCancellationRequested(() => {
				void api.cancel({ id, requestId }).catch(() => {
					/* Cancellation can race connection disposal. */
				});
			});
			try {
				const result = await api.call({ ...params, id, requestId, path: doc.path, version, method });
				if (
					doc.disposed ||
					doc.model.getVersionId() !== version ||
					token?.isCancellationRequested ||
					doc.connection?.id !== id
				)
					return null;
				return { data: result.data as LanguageResults[M], change: result.change };
			} catch (error) {
				if (
					!token?.isCancellationRequested &&
					!doc.disposed &&
					doc.model.getVersionId() === version &&
					doc.connection?.id === id
				)
					setError(doc, error);
				return null;
			} finally {
				cancelled?.dispose();
			}
		} catch (error) {
			if (doc.generation === generation) setError(doc, error);
			return null;
		}
	}
	function diagnostics(
		doc: EditorLanguageDocument,
		values: Array<{
			range: Range;
			message: string;
			severity?: number | undefined;
			code?: string | number | undefined;
			source?: string | undefined;
		}>,
	) {
		monaco.editor.setModelMarkers(
			doc.model,
			"ling-language",
			values.map((value) => ({
				...editorRange(value.range),
				message: value.message,
				severity:
					value.severity === 1
						? monaco.MarkerSeverity.Error
						: value.severity === 2
							? monaco.MarkerSeverity.Warning
							: value.severity === 4
								? monaco.MarkerSeverity.Hint
								: monaco.MarkerSeverity.Info,
				...(value.code === undefined ? {} : { code: String(value.code) }),
				...(value.source === undefined ? {} : { source: value.source }),
			})),
		);
		doc.error = null;
		notify();
	}
	async function refresh(doc: EditorLanguageDocument) {
		await flush(doc);
		if (doc.disposed || !doc.connection?.capabilities.diagnosticProvider) return;
		doc.diagnosticToken?.dispose(true);
		const token = new monaco.CancellationTokenSource();
		doc.diagnosticToken = token;
		const result = await request(doc, "diagnostics", {}, token.token);
		if (result?.data.kind === "full")
			diagnostics(
				doc,
				result.data.items.map((item) => ({
					...item,
					message: typeof item.message === "string" ? item.message : item.message.value,
				})),
			);
	}
	function schedule(doc: EditorLanguageDocument) {
		if (doc.timer) clearTimeout(doc.timer);
		doc.diagnosticToken?.cancel();
		monaco.editor.setModelMarkers(doc.model, "ling-language", []);
		// Coalesce keystrokes; explicit navigation and completion flush immediately.
		doc.timer = setTimeout(() => {
			doc.timer = null;
			void refresh(doc).catch((error) => setError(doc, error));
		}, 250);
	}
	function disposeDocument(doc: EditorLanguageDocument): Promise<void> {
		const key = doc.model.uri.toString();
		if (doc.disposed) return closing.get(key) ?? Promise.resolve();
		doc.disposed = true;
		documents.delete(key);
		if (doc.timer) clearTimeout(doc.timer);
		doc.diagnosticToken?.dispose(true);
		for (const release of doc.releases) release.dispose();
		const operation = (async () => {
			await doc.ready;
			await doc.sync;
			if (doc.connection) await api.close({ id: doc.connection.id, path: doc.path });
			if (!doc.model.isDisposed()) monaco.editor.setModelMarkers(doc.model, "ling-language", []);
			notify();
		})();
		closing.set(key, operation);
		void operation
			.finally(() => {
				if (closing.get(key) === operation) closing.delete(key);
			})
			.catch((error) => console.error(formatRequestError(error)));
		return operation;
	}
	const onDiagnostics = api.onDiagnostics((value) => {
		for (const doc of documents.values())
			if (doc.connection?.id === value.id && doc.path === value.path) {
				if (value.reconnect) {
					doc.connection = null;
					monaco.editor.setModelMarkers(doc.model, "ling-language", []);
					doc.ready = start(doc);
					void doc.ready.then(() => refresh(doc)).catch((error) => setError(doc, error));
					continue;
				}
				if (value.error) setError(doc, new Error(value.error));
				else if (doc.model.getVersionId() === value.version && !doc.connection.capabilities.diagnosticProvider)
					diagnostics(doc, value.diagnostics);
			}
	});
	const client = {
		async format(doc: EditorLanguageDocument, range?: Range) {
			const current = snapshot(doc);
			const result = await api.format({ ...current, ...(range ? { range } : {}) });
			if (doc.disposed || current.version !== doc.model.getVersionId())
				throw new Error("The document changed during formatting");
			return result;
		},
		documents,
		views,
		request,
		flush,
		get version() {
			return revision;
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		get(model: monaco.editor.ITextModel) {
			return documents.get(model.uri.toString());
		},
		uri(doc: EditorLanguageDocument, uri: string) {
			return modelUri(doc.cwd, projectLanguagePath(doc.cwd, uri));
		},
		async loadLocations(doc: EditorLanguageDocument, uris: string[]) {
			const view = [...views].find(([editor]) => editor.getModel() === doc.model)?.[1];
			if (!view) return new Set<string>();
			releaseReferences(view);
			const retained = new Set<MonacoModelRecord>();
			references.set(view, retained);
			const loaded = new Set<string>(),
				unique = [...new Set(uris)];
			let characters = 0;
			// Peek needs models, but a repository-wide reference query must not retain every source file.
			if (unique.length > 50) setError(doc, new Error("Only the first 50 referenced files can be previewed at once"));
			for (const uri of unique.slice(0, 50)) {
				try {
					const model = await view.load(projectLanguagePath(doc.cwd, uri));
					if (references.get(view) !== retained || doc.disposed) {
						trimModelRecords();
						break;
					}
					// The current peek owns at most 8 MiB of UTF-16 text, independently of dirty user buffers.
					characters += model.getValueLength();
					if (characters > 4 * 1_048_576) {
						setError(doc, new Error("Referenced files exceed the preview memory budget"));
						trimModelRecords();
						break;
					}
					const record = [...modelRecords.values()].find((record) => record.model === model);
					if (record && !retained.has(record)) {
						record.activeEditors++;
						retained.add(record);
					}
					loaded.add(uri);
				} catch (error) {
					setError(doc, error);
				}
			}
			return loaded;
		},
		report: setError,
		track(model: monaco.editor.ITextModel, cwd: string, path: string) {
			let doc = documents.get(model.uri.toString());
			if (!doc) {
				doc = {
					model,
					cwd,
					path,
					connection: null,
					error: null,
					ready: Promise.resolve(),
					version: 0,
					disposed: false,
					generation: 0,
					sync: Promise.resolve(),
					timer: null,
					diagnosticToken: null,
					owners: 0,
					releases: [],
				};
				documents.set(model.uri.toString(), doc);
				const owner = doc;
				owner.releases.push(
					model.onDidChangeContent(() => schedule(owner)),
					model.onWillDispose(() => {
						void disposeDocument(owner).catch((error) => console.error(formatRequestError(error)));
					}),
				);
				owner.ready = start(owner);
				void owner.ready.then(() => refresh(owner)).catch((error) => setError(owner, error));
			}
			return doc;
		},
		attach(
			model: monaco.editor.ITextModel,
			cwd: string,
			path: string,
			editor: monaco.editor.ICodeEditor,
			view: EditorLanguageView,
		) {
			const doc = client.track(model, cwd, path);
			doc.owners++;
			views.set(editor, view);
			const owner = doc;
			// The bounded model registry owns the document, including unsaved imports in inactive tabs.
			return () => {
				views.delete(editor);
				releaseReferences(view);
				owner.owners--;
			};
		},
		async retry(model: monaco.editor.ITextModel) {
			const doc = documents.get(model.uri.toString());
			if (!doc) return;
			if (doc.connection) await api.close({ id: doc.connection.id, path: doc.path });
			doc.connection = null;
			doc.ready = start(doc);
			await refresh(doc);
		},
	};
	const providers = registerLanguageProviders(client);
	const releaseSave = onModelSaved((model, savedText) => {
		const doc = client.get(model);
		if (!doc || doc.disposed) return;
		void flush(doc)
			.then(async () => {
				if (doc.connection && !doc.disposed) {
					await api.save({ id: doc.connection.id, path: doc.path, text: savedText });
					await refresh(doc);
				}
			})
			.catch((error) => setError(doc, error));
	});
	window.addEventListener(
		"pagehide",
		() => {
			onDiagnostics();
			releaseSave();
			providers.dispose();
			for (const doc of [...documents.values()])
				void disposeDocument(doc).catch((error) => console.error(formatRequestError(error)));
		},
		{ once: true },
	);
	return client;
}
export type EditorLanguageClient = ReturnType<typeof createEditorLanguageClient>;
