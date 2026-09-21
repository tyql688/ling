import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as monaco from "monaco-editor";
import { useTranslation } from "react-i18next";
import type { EditorWorkspaceChange, LanguageResults } from "@ling/contracts/editor-language";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import type { WorkspaceFilePreviewProps } from "./use-file-preview-pane";
import { getEditorLanguageClient } from "./editor-language-client";
import { editorRange, languageRange, projectLanguagePath } from "./editor-coordinates";
import { editorOutlineAtom, editorRevealAtom, type EditorOutlineItem } from "./editor-navigation";
import { prepareEditorChange, type PreparedEditorChange } from "./editor-workspace-edits";
import { fileDocumentKey, markFileDocumentDirtyAtom } from "./file-document-state";
import { modelRecords, createModelRecord } from "./monaco-documents";
import { runLanguageAction } from "./editor-language-providers";

interface EditorMenuAction {
	id: string;
	title: string;
	run(): void | Promise<void>;
	disabled?: boolean;
	separateBefore?: boolean;
}
export function useEditorFeatures(
	editor: monaco.editor.IStandaloneCodeEditor | null,
	props: Pick<WorkspaceFilePreviewProps, "cwd" | "path" | "viewKey" | "onOpenFile" | "onInsertReference">,
) {
	const { cwd, path, viewKey = cwd } = props;
	const { t } = useTranslation(),
		api = useDomainApi("editorLanguage"),
		projectApi = useDomainApi("project");
	const language = useMemo(() => getEditorLanguageClient(api), [api]);
	useSyncExternalStore(language.subscribe, () => language.version);
	const onError = useCommandFeedback(),
		markDirty = useSetAtom(markFileDocumentDirtyAtom),
		setOutline = useSetAtom(editorOutlineAtom);
	const [proposal, setProposal] = useState<PreparedEditorChange | null>(null),
		[selectedFile, setSelectedFile] = useState(0);
	const [symbolsOpen, setSymbolsOpen] = useState(false),
		[symbolQuery, setSymbolQuery] = useState("");
	const [symbols, setSymbols] = useState<NonNullable<LanguageResults["workspaceSymbols"]>>([]);
	const [symbolsLoading, setSymbolsLoading] = useState(false);
	const pending = useRef<{ change: PreparedEditorChange; resolve(accepted: boolean): void } | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const mounted = useRef(true),
		prepareSequence = useRef(0);
	const reveal = useAtomValue(editorRevealAtom),
		setReveal = useSetAtom(editorRevealAtom);
	const propose = useCallback(
		async (change: EditorWorkspaceChange): Promise<boolean> => {
			if (pending.current) throw new Error(t("editor.finishReview"));
			const sequence = ++prepareSequence.current;
			const prepared = await prepareEditorChange(cwd, change, projectApi, markDirty);
			if (!mounted.current || sequence !== prepareSequence.current) {
				prepared.release();
				return false;
			}
			if (!prepared.files.length || prepared.files.every((file) => file.before === file.after)) {
				prepared.release();
				return false;
			}
			setProposal(prepared);
			setSelectedFile(0);
			return new Promise((resolve) => {
				pending.current = { change: prepared, resolve };
			});
		},
		[cwd, markDirty, projectApi, t],
	);
	const finishReview = useCallback(
		(accept: boolean) => {
			const current = pending.current;
			if (!current) return;
			if (accept) {
				try {
					current.change.apply();
					for (const file of current.change.files) {
						language.track(file.record.model, cwd, file.path);
						latest.current.onOpenFile(file.path, true);
					}
				} catch (error) {
					onError(error);
					return;
				}
			}
			pending.current = null;
			current.change.release();
			current.resolve(accept);
			setProposal(null);
		},
		[cwd, language, onError],
	);
	const proposeRef = useRef(propose);
	proposeRef.current = propose;
	useEffect(() => {
		mounted.current = true;
		const sequenceOwner = prepareSequence;
		setProposal(null);
		return () => {
			mounted.current = false;
			sequenceOwner.current++;
			const current = pending.current;
			if (current) {
				current.change.release();
				current.resolve(false);
				pending.current = null;
			}
		};
	}, [cwd, path]);
	useEffect(() => {
		const model = editor?.getModel();
		if (!editor || !model || path === null) return;
		return language.attach(model, cwd, path, editor, {
			open: (path, range) => latest.current.onOpenFile(path, false, range),
			async load(path) {
				const existing = modelRecords.get(fileDocumentKey(cwd, path));
				if (existing) return existing.model;
				const preview = await projectApi.readFilePreview({ cwd, path });
				if (preview.kind !== "text") throw new Error(`Cannot preview this reference: ${path}`);
				return createModelRecord(cwd, path, preview, projectApi, markDirty).model;
			},
			propose: (change) => proposeRef.current(change),
		});
	}, [cwd, path, editor, language, projectApi, markDirty]);
	useEffect(() => {
		if (editor && reveal?.viewKey === viewKey && reveal.path === path) {
			editor.setSelection(reveal.range);
			editor.revealRangeInCenter(reveal.range);
			editor.focus();
			setReveal(null);
		}
	}, [editor, path, reveal, setReveal, viewKey]);
	const doc = editor?.getModel() ? language.get(editor.getModel()!) : undefined;
	const connection = doc?.connection;
	useEffect(() => {
		if (!doc || path === null) return;
		let stopped = false,
			timer: ReturnType<typeof setTimeout> | null = null;
		const token = new monaco.CancellationTokenSource();
		const update = async () => {
			await doc.ready;
			if (stopped) return;
			if (!connection?.capabilities.documentSymbolProvider) {
				setOutline((current) => (current?.viewKey === viewKey && current.path === path ? null : current));
				return;
			}
			setOutline((current) => ({
				viewKey,
				path,
				items: current?.path === path && current.viewKey === viewKey ? current.items : [],
				loading: true,
				error: null,
			}));
			const version = doc.model.getVersionId(),
				result = await language.request(doc, "symbols", {}, token.token);
			if (stopped || version !== doc.model.getVersionId()) return;
			const items: EditorOutlineItem[] = [];
			const add = (values: NonNullable<LanguageResults["symbols"]>, depth = 0) => {
				for (const value of values) {
					const range = "selectionRange" in value ? value.selectionRange : value.location.range;
					items.push({
						name: value.name,
						detail: "detail" in value ? (value.detail ?? "") : "",
						kind: value.kind,
						range: editorRange(range),
						depth,
					});
					if ("children" in value && value.children) add(value.children, depth + 1);
				}
			};
			if (result?.data) add(result.data);
			setOutline({ viewKey, path, items, loading: false, error: doc.error });
		};
		const changed = doc.model.onDidChangeContent(() => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				void update().catch(onError);
			}, 400);
		});
		void update().catch(onError);
		return () => {
			stopped = true;
			token.dispose(true);
			changed.dispose();
			if (timer) clearTimeout(timer);
			setOutline((current) => (current?.viewKey === viewKey && current.path === path ? null : current));
		};
	}, [connection, doc, language, onError, path, setOutline, viewKey]);
	useEffect(() => {
		if (!symbolsOpen || !doc) return;
		if (!connection?.capabilities.workspaceSymbolProvider) {
			setSymbols([]);
			setSymbolsLoading(false);
			return;
		}
		const token = new monaco.CancellationTokenSource();
		const timer = setTimeout(() => {
			setSymbolsLoading(true);
			void language
				.request(doc, "workspaceSymbols", { query: symbolQuery }, token.token)
				.then((result) => {
					if (!token.token.isCancellationRequested) {
						setSymbols(result?.data ?? []);
						setSymbolsLoading(false);
					}
				})
				.catch(onError);
		}, 180);
		return () => {
			clearTimeout(timer);
			token.dispose(true);
		};
	}, [connection, doc, language, onError, symbolQuery, symbolsOpen]);
	const run = (id: string) => async () => {
		if (!editor) return;
		editor.focus();
		const action = editor.getAction(id);
		if (action) await action.run();
		// Monaco also registers commands, including Quick Fix, outside getAction().
		else editor.trigger("ling.contextMenu", id, undefined);
	};
	const agent = (intent: "explain" | "fix" | "refactor") => () => {
		if (!editor || !path) return;
		const model = editor.getModel()!;
		const record = [...modelRecords.values()].find((entry) => entry.model === model);
		const snapshot = {
			version: model.getVersionId(),
			baseRevision: record?.baseRevision,
			diagnostics: monaco.editor.getModelMarkers({ resource: model.uri }).map((marker) => ({
				range: languageRange(model.validateRange(marker)),
				message: marker.message,
				severity:
					marker.severity === monaco.MarkerSeverity.Error
						? 1
						: marker.severity === monaco.MarkerSeverity.Warning
							? 2
							: marker.severity === monaco.MarkerSeverity.Info
								? 3
								: 4,
			})),
		};
		let selection = model.validateRange(editor.getSelection()!);
		if (selection.isEmpty())
			selection = new monaco.Selection(
				selection.startLineNumber,
				1,
				selection.startLineNumber,
				model.getLineMaxColumn(selection.startLineNumber),
			);
		const selected = model.getValueInRange(selection);
		if (selected.length > 100_000) throw new Error(t("editor.selectionTooLarge"));
		const diagnostics = snapshot.diagnostics.filter(
			(item) =>
				item.range.start.line <= selection.endLineNumber - 1 && item.range.end.line >= selection.startLineNumber - 1,
		);
		const context =
			t("editor.agentContext", {
				intent: t(`editor.${intent}`),
				path,
				start: selection.startLineNumber,
				end: selection.endLineNumber,
				version: snapshot.version,
			}) +
			"\n" +
			JSON.stringify(
				{ selection: languageRange(selection), text: selected, diagnostics, baseRevision: snapshot.baseRevision },
				null,
				2,
			);
		latest.current.onInsertReference(path, {
			lineRange: { start: selection.startLineNumber, end: selection.endLineNumber },
			editorContext: context,
		});
	};
	const actions: EditorMenuAction[] = [
		{ id: "find", title: t("editor.find"), run: run("actions.find") },
		{ id: "replace", title: t("editor.replace"), run: run("editor.action.startFindReplaceAction") },
		{ id: "goToLine", title: t("editor.goToLine"), run: run("editor.action.gotoLine") },
		{ id: "symbols", title: t("editor.fileSymbols"), run: run("editor.action.quickOutline") },
		{
			id: "workspaceSymbols",
			separateBefore: true,
			title: t("editor.workspaceSymbols"),
			disabled: !doc?.connection?.capabilities.workspaceSymbolProvider,
			run: () => setSymbolsOpen(true),
		},
		{
			id: "definition",
			title: t("editor.definition"),
			disabled: !doc?.connection?.capabilities.definitionProvider,
			run: run("editor.action.revealDefinition"),
		},
		{
			id: "peek",
			title: t("editor.peekDefinition"),
			disabled: !doc?.connection?.capabilities.definitionProvider,
			run: run("editor.action.peekDefinition"),
		},
		{ id: "hover", title: t("editor.hover"), run: run("editor.action.showHover") },
		{
			id: "references",
			title: t("editor.references"),
			disabled: !doc?.connection?.capabilities.referencesProvider,
			run: run("editor.action.referenceSearch.trigger"),
		},
		{
			id: "rename",
			title: t("editor.rename"),
			disabled: !doc?.connection?.capabilities.renameProvider,
			run: run("editor.action.rename"),
		},
		{ id: "format", separateBefore: true, title: t("editor.format"), run: run("editor.action.formatDocument") },
		{ id: "rangeFormat", title: t("editor.rangeFormat"), run: run("editor.action.formatSelection") },
		{
			id: "quickFix",
			title: t("editor.quickFix"),
			disabled: !doc?.connection?.capabilities.codeActionProvider,
			run: run("editor.action.quickFix"),
		},
		{
			id: "organizeImports",
			title: t("editor.organizeImports"),
			disabled: !doc?.connection?.capabilities.codeActionProvider,
			async run() {
				if (!doc || !editor) return;
				const result = await language.request(doc, "codeActions", {
					range: languageRange(editor.getModel()!.getFullModelRange()),
				});
				const action = result?.data?.find(
					(value) => "kind" in value && value.kind?.startsWith("source.organizeImports"),
				);
				if (action) await runLanguageAction(language, doc, (action as unknown as { lingTicket: string }).lingTicket);
			},
		},
		{ id: "explain", separateBefore: true, title: t("editor.explain"), run: agent("explain") },
		{ id: "fix", title: t("editor.fix"), run: agent("fix") },
		{ id: "refactor", title: t("editor.refactor"), run: agent("refactor") },
		{
			id: "addToChat",
			separateBefore: true,
			title: t("explorer.addToChat"),
			run() {
				if (path) latest.current.onInsertReference(path);
			},
		},
		{
			id: "selectionToChat",
			title: t("editor.addSelection"),
			run() {
				const selection = editor?.getSelection();
				if (path && selection)
					latest.current.onInsertReference(path, {
						lineRange: { start: selection.startLineNumber, end: selection.endLineNumber },
					});
			},
		},
	];
	return {
		actions,
		execute(action: EditorMenuAction) {
			void Promise.resolve().then(action.run).catch(onError);
		},
		proposal,
		selectedFile,
		setSelectedFile,
		finishReview,
		error: doc?.error,
		connected: Boolean(doc?.connection),
		retry: () => {
			if (editor?.getModel()) void language.retry(editor.getModel()!).catch(onError);
		},
		symbolsOpen,
		setSymbolsOpen,
		symbolQuery,
		setSymbolQuery,
		symbols,
		symbolsLoading,
		openSymbol(value: NonNullable<LanguageResults["workspaceSymbols"]>[number]) {
			try {
				latest.current.onOpenFile(
					projectLanguagePath(cwd, value.location.uri),
					false,
					editorRange(value.location.range),
				);
				setSymbolsOpen(false);
			} catch (error) {
				onError(error);
			}
		},
	};
}
export type EditorFeatures = ReturnType<typeof useEditorFeatures>;
