import { captureFiles } from "./use-image-attachments";
import { useDomainApi } from "@renderer/lib/host-api-context";
import type { PendingFileReference } from "@ling/contracts/draft";
import {
	PROJECT_FILE_REFERENCE_MAX_ITEMS,
	type ProjectDroppedFileReferenceResult,
	type ProjectFileReferenceLineRange,
	type ProjectFileReferenceTarget,
} from "@ling/contracts/project";
import { SESSION_IMAGE_MAX_ITEMS } from "@ling/contracts/session";
import { fileReferenceKey } from "@renderer/features/sessions/state/composer-file-references";
import pLimit from "p-limit";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { type AttachmentSource, useImageAttachments } from "./use-image-attachments";

export type FileReferenceIssue =
	{ code: "path-unavailable"; fileName: string } | { code: "resolve-failed" } | { code: "count" };

type FileReferenceSource = readonly [PendingFileReference[], Dispatch<SetStateAction<PendingFileReference[]>>];

const COMPOSER_FILE_CAPTURE_LIMIT = SESSION_IMAGE_MAX_ITEMS + PROJECT_FILE_REFERENCE_MAX_ITEMS + 1;

/** Images use the existing bounded data-URL path. Other files stay metadata-only and
 * resolve in one bounded IPC batch; no file contents are read by the composer. */
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
		if (fileReferencesRef.current.length >= PROJECT_FILE_REFERENCE_MAX_ITEMS) {
			setFileReferenceIssue({ code: "count" });
			return null;
		}
		setFileReferenceIssue(null);
		// The editor inserts the reference and removes its completion token in one transaction.
		return { id: crypto.randomUUID(), scope: "project", path, ...options };
	};

	const addFiles = (files: Iterable<File>): Promise<void> => {
		// FileList is live: capture it before the picker clears its value after onChange.
		const candidates = captureFiles(files, COMPOSER_FILE_CAPTURE_LIMIT);
		const operationScopeKey = scopeKey;
		return addQueueRef.current(async () => {
			const imageFiles = candidates.filter((file) => file.type.startsWith("image/"));
			const pathFiles = candidates.filter((file) => !file.type.startsWith("image/"));
			await images.addFiles(imageFiles);
			if (scopeKeyRef.current !== operationScopeKey) return;
			let issue: FileReferenceIssue | null =
				candidates.length >= COMPOSER_FILE_CAPTURE_LIMIT ? { code: "count" } : null;
			setFileReferenceIssue(issue);
			if (pathFiles.length === 0) return;

			const boundedFiles = pathFiles.slice(0, PROJECT_FILE_REFERENCE_MAX_ITEMS);
			let results: ProjectDroppedFileReferenceResult[];
			try {
				results =
					cwd === null
						? boundedFiles.map(() => ({ status: "unavailable" as const }))
						: await hostProjectApi.resolveDroppedFileReferences(cwd, boundedFiles);
			} catch {
				if (scopeKeyRef.current === operationScopeKey) setFileReferenceIssue({ code: "resolve-failed" });
				return;
			}
			if (scopeKeyRef.current !== operationScopeKey) return;
			const targets: ProjectFileReferenceTarget[] = [];
			if (pathFiles.length > boundedFiles.length) issue ??= { code: "count" };
			for (const [index, result] of results.entries()) {
				if (result.status === "ok") targets.push(result.reference);
				else issue ??= { code: "path-unavailable", fileName: boundedFiles[index]?.name ?? "file" };
			}
			if (!appendReferences(targets)) issue ??= { code: "count" };
			setFileReferenceIssue(issue);
		});
	};

	return {
		...images,
		addFiles,
		createProjectFileReference,
		fileReferences,
		fileReferenceIssue,
	};
}
