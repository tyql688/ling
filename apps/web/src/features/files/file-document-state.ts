import { atom } from "jotai";

/** Shared content belongs to the project file, independently of the session displaying it. */
export function fileDocumentKey(cwd: string, path: string): string {
	return `${cwd}\0${path}`;
}

export const dirtyFileDocumentsAtom = atom<ReadonlySet<string>>(new Set<string>());
export const markFileDocumentDirtyAtom = atom(null, (get, set, { key, dirty }: { key: string; dirty: boolean }) => {
	const current = get(dirtyFileDocumentsAtom);
	if (current.has(key) === dirty) return;
	const next = new Set(current);
	if (dirty) next.add(key);
	else next.delete(key);
	set(dirtyFileDocumentsAtom, next);
});

interface RetainedFileDocument {
	content(): string;
	save(): Promise<boolean>;
	discard(): void;
}
const retainedDocuments = new Map<string, RetainedFileDocument>();
/** The Monaco model owns this registration, including while its view is inactive. */
export function retainFileDocument(key: string, document: RetainedFileDocument): () => void {
	retainedDocuments.set(key, document);
	return () => {
		if (retainedDocuments.get(key) === document) retainedDocuments.delete(key);
	};
}
export function getRetainedFileDocument(key: string): RetainedFileDocument | undefined {
	return retainedDocuments.get(key);
}
