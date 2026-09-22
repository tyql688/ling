import { captureFiles } from "./use-image-attachments";
import { useDomainApi } from "@renderer/lib/host-api-context";
import type { PendingFileReference } from "@ling/contracts/draft";
import {
	PROJECT_FILE_REFERENCE_MAX_ITEMS,
	type ProjectDroppedFileReferenceResult,
	type ProjectFileReferenceLineRange,
	type ProjectFileReferenceTarget,
} from "@ling/contracts/project";
import { attachmentMediaType } from "@ling/contracts/attachments";
import { uploadAttachment } from "@renderer/platform/attachment-upload";
import { formatRequestError } from "@renderer/lib/errors";
import { fileReferenceKey } from "@renderer/features/sessions/state/composer-file-references";
import pLimit from "p-limit";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { type AttachmentSource, useImageAttachments } from "./use-image-attachments";

export type FileReferenceIssue =
	| { code: "path-unavailable"; fileName: string }
	| { code: "resolve-failed" }
	| { code: "count" }
	| { code: "import-failed"; fileName: string; message: string };

type FileReferenceSource = readonly [PendingFileReference[], Dispatch<SetStateAction<PendingFileReference[]>>];

const COMPOSER_FILE_CAPTURE_LIMIT = PROJECT_FILE_REFERENCE_MAX_ITEMS + 1;

/** Local files remain path references. Only pathless images are encoded inline; other
 * browser files stream to the authenticated Host and become durable file references. */
export function useComposerAttachments(
	cwd: string | null,
	scopeKey: string,
	imageSource?: AttachmentSource,
	fileReferenceSource?: FileReferenceSource,
) {
	const hostProjectApi = useDomainApi("project");

	const images = useImageAttachments(imageSource, scopeKey);
	const internalFileReferences = useState<PendingFileReference[]>([]);
	const fileReferencesAreExternal = fileReferenceSource !== undefined;
	const [fileReferences, setFileReferences] = fileReferenceSource ?? internalFileReferences;
	const [fileReferenceIssueState, setFileReferenceIssueState] = useState<{
		scopeKey: string;
		issue: FileReferenceIssue;
	} | null>(null);
	const fileReferencesRef = useRef(fileReferences);
	fileReferencesRef.current = fileReferences;
	const addQueueRef = useRef(pLimit(1));
	const controllers = useRef(new Set<AbortController>());
	const [pending, setPending] = useState<{ scope: string; count: number }>({ scope: scopeKey, count: 0 });
	useEffect(
		() => () => {
			for (const controller of controllers.current) controller.abort();
			controllers.current.clear();
		},
		[scopeKey],
	);
	const previousCwdRef = useRef(cwd);
	const scopeKeyRef = useRef(scopeKey);
	scopeKeyRef.current = scopeKey;
	const fileReferenceIssue = fileReferenceIssueState?.scopeKey === scopeKey ? fileReferenceIssueState.issue : null;
	const setFileReferenceIssue = (issue: FileReferenceIssue | null) =>
		setFileReferenceIssueState(issue === null ? null : { scopeKey: scopeKeyRef.current, issue });

	useEffect(() => {
		if (previousCwdRef.current === cwd) return;
		previousCwdRef.current = cwd;
		setFileReferenceIssueState(null);
		if (fileReferencesAreExternal) return;
		fileReferencesRef.current = [];
		setFileReferences([]);
	}, [cwd, fileReferencesAreExternal, setFileReferences]);

	const appendReferences = (targets: readonly (ProjectFileReferenceTarget & { directory?: boolean })[]): boolean => {
		const next = [...fileReferencesRef.current];
		const seen = new Set(next.map(fileReferenceKey));
		let limitExceeded = false;
		for (const target of targets) {
			const key = fileReferenceKey(target);
			if (seen.has(key)) continue;
			if (next.length >= PROJECT_FILE_REFERENCE_MAX_ITEMS) {
				limitExceeded = true;
				break;
			}
			seen.add(key);
			next.push({ id: crypto.randomUUID(), ...target });
		}
		if (next.length !== fileReferencesRef.current.length) {
			fileReferencesRef.current = next;
			setFileReferences(next);
		}
		return !limitExceeded;
	};

	const createProjectFileReference = (
		path: string,
		options?: { directory?: boolean; lineRange?: ProjectFileReferenceLineRange },
	): PendingFileReference | null => {
		const target = { scope: "project" as const, path, ...options };
		const existing = fileReferencesRef.current.find(
			(reference) => fileReferenceKey(reference) === fileReferenceKey(target),
		);
		if (existing) {
			setFileReferenceIssue(null);
			return existing;
		}
		if (fileReferencesRef.current.length >= PROJECT_FILE_REFERENCE_MAX_ITEMS) {
			setFileReferenceIssue({ code: "count" });
			return null;
		}
		setFileReferenceIssue(null);
		// The editor inserts the reference and removes its completion token in one transaction.
		return { id: crypto.randomUUID(), ...target };
	};

	const addFiles = (files: Iterable<File>): Promise<void> => {
		const captured = captureFiles(files, COMPOSER_FILE_CAPTURE_LIMIT);
		if (captured.length === 0) return Promise.resolve();
		const candidates = captured.slice(0, PROJECT_FILE_REFERENCE_MAX_ITEMS);
		const operationScopeKey = scopeKey;
		const controller = new AbortController();
		controllers.current.add(controller);
		setPending((current) => ({
			scope: operationScopeKey,
			count: current.scope === operationScopeKey ? current.count + 1 : 1,
		}));
		const current = () => scopeKeyRef.current === operationScopeKey && !controller.signal.aborted;
		return addQueueRef
			.current(async () => {
				if (!current()) return;
				setFileReferenceIssue(null);
				let results: ProjectDroppedFileReferenceResult[];
				try {
					results =
						cwd === null
							? candidates.map(() => ({ status: "unavailable" as const }))
							: await hostProjectApi.resolveDroppedFileReferences(cwd, candidates);
				} catch {
					if (current()) setFileReferenceIssue({ code: "resolve-failed" });
					return;
				}
				let issue: FileReferenceIssue | null = captured.length > candidates.length ? { code: "count" } : null;
				for (const [index, file] of candidates.entries()) {
					if (!current()) return;
					const result = results[index];
					if (result?.status === "ok") {
						if (!appendReferences([result.reference])) issue ??= { code: "count" };
						continue;
					}
					const mimeType = file.type || attachmentMediaType(file.name) || "application/octet-stream";
					if (mimeType.startsWith("image/")) {
						await images.addFiles([file.type ? file : new File([file], file.name, { type: mimeType })]);
						continue;
					}
					if (cwd === null) {
						issue ??= { code: "path-unavailable", fileName: file.name };
						continue;
					}
					if (fileReferencesRef.current.length >= PROJECT_FILE_REFERENCE_MAX_ITEMS) {
						issue ??= { code: "count" };
						continue;
					}
					try {
						const reference = await uploadAttachment(cwd, file, controller.signal);
						if (current() && !appendReferences([reference])) issue ??= { code: "count" };
					} catch (error) {
						if (!current()) return;
						issue ??= { code: "import-failed", fileName: file.name, message: formatRequestError(error) };
					}
				}
				if (current()) setFileReferenceIssue(issue);
			})
			.finally(() => {
				controllers.current.delete(controller);
				setPending((value) =>
					value.scope === operationScopeKey ? { ...value, count: Math.max(0, value.count - 1) } : value,
				);
			});
	};

	const handlePaste = (event: ClipboardEvent) => {
		const files = event.clipboardData?.files;
		if (!files?.length) return;
		event.preventDefault();
		void addFiles(files);
	};

	return {
		...images,
		addFiles,
		handlePaste,
		addingAttachments: pending.scope === scopeKey && pending.count > 0,
		createProjectFileReference,
		fileReferences,
		fileReferenceIssue,
	};
}
