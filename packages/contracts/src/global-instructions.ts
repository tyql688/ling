import type { PiResourceReloadSummary } from "./session";
/** Pi loads three global prompt files from `~/.pi/agent/` at session startup: `agents` (`AGENTS.md`) appends instructions, `system` (`SYSTEM.md`) replaces the default system prompt, and `append-system` (`APPEND_SYSTEM.md`) appends to it. Ling edits these global files; project context stays under Pi's project configuration. */
export type GlobalInstructionKind = (typeof GLOBAL_INSTRUCTION_KINDS)[number];

export const GLOBAL_INSTRUCTION_KINDS = ["agents", "system", "append-system"] as const;

/** Filenames shared by renderer and main. */
export const GLOBAL_INSTRUCTION_FILE_NAMES: Readonly<Record<GlobalInstructionKind, string>> = {
	agents: "AGENTS.md",
	system: "SYSTEM.md",
	"append-system": "APPEND_SYSTEM.md",
};

/** Read result. `content` is `null` when the file does not exist yet. */
export interface GlobalInstructionFile {
	kind: GlobalInstructionKind;
	content: string | null;
	reload?: PiResourceReloadSummary;
}

/** Save request. An empty/whitespace-only `content` deletes the file so the directory
 * stays clean and Pi stops loading it. */
export interface GlobalInstructionSaveRequest {
	kind: GlobalInstructionKind;
	content: string;
}

/** Revealed/opened path for a kind, plus the owning global agent directory. */
export interface GlobalInstructionLocation {
	kind: GlobalInstructionKind;
	fileName: string;
	filePath: string;
	exists: boolean;
	dir: string;
}

/** Caps bytes written to a global prompt file through IPC. */
export const GLOBAL_INSTRUCTION_MAX_BYTES = 512 * 1024;
