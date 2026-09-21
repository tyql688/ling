import type { PendingFileReference } from "@ling/contracts/draft";
import {
	PROJECT_FILE_REFERENCE_MAX_ITEMS,
	type ProjectFileReferenceLineRange,
	type ProjectFileReferenceTarget,
} from "@ling/contracts/project";
import { mergeFileReferenceTargets } from "@ling/contracts/file-reference-text";

/** Extra info when inserting a reference from the tree/preview context menu: directory marker (chip icon) and selection line range. */
export interface InsertFileReferenceOptions {
	directory?: boolean;
	lineRange?: ProjectFileReferenceLineRange;
	/** An explicit editor action appends its reviewed source snapshot to the current draft. */
	editorContext?: string;
}

export function fileReferenceKey(reference: ProjectFileReferenceTarget): string {
	const range =
		reference.scope === "project" && reference.lineRange !== undefined
			? `:${reference.lineRange.start}-${reference.lineRange.end}`
			: "";
	return `${reference.scope}:${reference.path}${range}`;
}

export function fileReferenceTarget(reference: ProjectFileReferenceTarget): ProjectFileReferenceTarget {
	if (reference.scope === "external") return { scope: "external", path: reference.path };
	return {
		scope: "project",
		path: reference.path,
		...(reference.lineRange === undefined ? {} : { lineRange: reference.lineRange }),
	};
}

/** Appends a project file reference to a draft's chip list, deduping by target identity and
 * enforcing the item cap. Used when inserting project files into a composer draft. */
export function draftWithProjectFileReference<T extends { fileReferences: PendingFileReference[] }>(
	draft: T,
	path: string,
	options?: InsertFileReferenceOptions,
): { draft: T; issue: "limit" | "duplicate" | null } {
	const reference: PendingFileReference = {
		id: crypto.randomUUID(),
		scope: "project",
		path,
		...(options?.directory === true ? { directory: true } : {}),
		...(options?.lineRange === undefined ? {} : { lineRange: options.lineRange }),
	};
	const targetKey = fileReferenceKey(fileReferenceTarget(reference));
	if (draft.fileReferences.some((existing) => fileReferenceKey(existing) === targetKey)) {
		return { draft, issue: "duplicate" };
	}
	if (draft.fileReferences.length >= PROJECT_FILE_REFERENCE_MAX_ITEMS) return { draft, issue: "limit" };
	return { draft: { ...draft, fileReferences: [...draft.fileReferences, reference] }, issue: null };
}

/** File chips only affect draft display; the send boundary projects them into the existing @path text protocol. */
export function mergeFileReferences(
	submitted: string | null,
	references: readonly PendingFileReference[],
): string | null {
	return mergeFileReferenceTargets(submitted, references);
}
