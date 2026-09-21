/** The three global prompt files Pi loads from `~/.pi/agent/` at session startup.
 *
 * - `agents` → `AGENTS.md`: appended instructions layered on top of the default system prompt.
 * - `system` → `SYSTEM.md`: replaces the default system prompt entirely.
 * - `append-system` → `APPEND_SYSTEM.md`: appended to the default system prompt without replacing it.
 *
 * Ling only manages these global files; project-scoped context files stay untouched.
 */
export type GlobalInstructionKind = (typeof GLOBAL_INSTRUCTION_KINDS)[number];

export const GLOBAL_INSTRUCTION_KINDS = ["agents", "system", "append-system"] as const;

/** Fixed filename for each kind. Kept in shared so renderer and main agree without re-deriving. */
export const GLOBAL_INSTRUCTION_FILE_NAMES: Readonly<Record<GlobalInstructionKind, string>> = {
	agents: "AGENTS.md",
	system: "SYSTEM.md",
	"append-system": "APPEND_SYSTEM.md",
};

/** Read result. `content` is `null` when the file does not exist yet. */
export interface GlobalInstructionFile {
	kind: GlobalInstructionKind;
	content: string | null;
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

/** Upper bound on a single file write, guarding the renderer→main boundary. */
export const GLOBAL_INSTRUCTION_MAX_BYTES = 512 * 1024;
