import { atom } from "jotai";

export interface EditorSelection {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}
interface EditorReveal {
	viewKey: string;
	path: string;
	range: EditorSelection;
	nonce: string;
}
export const editorRevealAtom = atom<EditorReveal | null>(null);
export interface EditorOutlineItem {
	name: string;
	detail: string;
	kind: number;
	range: EditorSelection;
	depth: number;
}
interface EditorOutlineState {
	viewKey: string;
	path: string;
	items: EditorOutlineItem[];
	loading: boolean;
	error: string | null;
}
/** Only the visible reading document publishes its outline; document buffers have their own longer lifetime. */
export const editorOutlineAtom = atom<EditorOutlineState | null>(null);
