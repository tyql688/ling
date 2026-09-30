import type { EditorSelection } from "./editor-navigation";
import type { InsertFileReferenceOptions } from "@renderer/features/sessions/state/composer-file-references";

export interface FileReadingView {
	mode: "rendered" | "source";
	scrollTop: number;
}

export interface WorkspaceFilePreviewProps {
	view?: FileReadingView | undefined;
	onViewChange?: (view: Partial<FileReadingView>) => void;
	viewKey?: string;
	onOpenFile: (path: string, range?: EditorSelection) => void;
	cwd: string;
	path: string | null;
	refreshRevision: string;
	onCopyPath: (path: string) => void;
	onInsertReference: (path: string, options?: InsertFileReferenceOptions) => void;
	onRevealEntry: ((path: string) => void) | undefined;
}
