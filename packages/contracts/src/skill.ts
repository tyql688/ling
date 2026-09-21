import type { z } from "zod";
import type * as requestSchemas from "./skill-requests";
import { ABSOLUTE_PATH_MAX_CHARS } from "./path-bounds";
import { SESSION_MESSAGE_TEXT_MAX_CHARS, type PiResourceReloadSummary } from "./session";

/** Where a skill was discovered. `project` entries carry the owning project cwd. */
type SkillScope = "user" | "project" | "temporary";
type SkillOrigin = "package" | "top-level";

/**
 * Where a skill was installed from, as recorded by the `skills` CLI in its lock file. Present
 * only for skills that CLI installed; a hand-placed directory or a package resource has none.
 */
export interface SkillProvenance {
	/** Repository shorthand the CLI stores, e.g. `owner/repo`. */
	source: string;
}

export interface SkillInfo {
	name: string;
	description: string;
	/** Absolute path of the SKILL.md (or root .md) file — the reveal target. */
	filePath: string;
	/** Source label from Pi (directory or package the skill came from). */
	source: string;
	scope: SkillScope;
	origin: SkillOrigin;
	/** Project the skill was resolved for; null for globally discovered skills. */
	projectCwd: string | null;
	/** Shipped inside the Ling app (builtin-skills/); read-only and versioned with the app. */
	builtin: boolean;
	/** Ling's per-skill switch; false means the skill is not loaded at all. */
	enabled: boolean;
	/** Hidden from the system prompt; only callable via /skill:name. */
	disableModelInvocation: boolean;
	/** Absent unless the `skills` CLI recorded this skill in a lock file. */
	provenance?: SkillProvenance;
}

interface SkillDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path: string | null;
}

export interface SkillsOverview {
	/** Every known skill, including Ling-disabled ones (`enabled: false`) so the UI can re-enable them. */
	skills: SkillInfo[];
	diagnostics: SkillDiagnostic[];
	/** Extra skill directories configured through Pi settings (`skills` array). */
	extraPaths: string[];
	/** Pi's global toggle for exposing skills as /skill:name commands. */
	enableSkillCommands: boolean;
	/** Pi's default global skills directory (~/.pi/agent/skills). */
	globalSkillsDir: string;
	/** Master switch for the packaged built-in skills; off unloads all of them. */
	builtinSkillsEnabled: boolean;
}

/** One globally installed `skills` CLI skill checked against its upstream repository. */
export interface SkillUpdateStatus {
	name: string;
	/** Repository shorthand from the lock file, e.g. `owner/repo`. */
	source: string;
	/** `unknown` mirrors the CLI's own skip reasons (local/git/well-known sources). */
	status: "up-to-date" | "update-available" | "unknown" | "error";
	/** Local files diverge from the install-time hash; null means the local tree could not be checked. */
	dirty: boolean | null;
	reason: string | null;
}

export type SkillUpdateRunRequest = z.infer<typeof requestSchemas.skillUpdateRunSchema>;

export interface SkillUpdateRunResult {
	/** The CLI's combined stdout/stderr, ANSI-stripped. */
	output: string;
	reload: PiResourceReloadSummary;
}

export type BuiltinSkillsMasterRequest = z.infer<typeof requestSchemas.builtinMasterRequestSchema>;

export type SkillEnabledRequest = z.infer<typeof requestSchemas.skillEnabledRequestSchema>;

/** Toggle mutations return the live-resource reload outcome, like path mutations. */
export interface SkillToggleMutationResponse {
	reload: PiResourceReloadSummary;
}

export type RevealSkillRequest = z.infer<typeof requestSchemas.skillFilePathSchema>;

export type SkillContentRequest = z.infer<typeof requestSchemas.skillFilePathSchema>;

export type SkillResourceKind = "script" | "reference" | "asset";
type SkillResourceContentKind = "text" | "binary";

export interface SkillResourceInfo {
	relativePath: string;
	kind: SkillResourceKind;
	contentKind: SkillResourceContentKind;
	byteLength: number;
}

export type SkillResourceListRequest = z.infer<typeof requestSchemas.skillFilePathSchema>;

export interface SkillResourcesSnapshot {
	resources: SkillResourceInfo[];
	truncated: boolean;
}

export type SkillResourceRequest = z.infer<typeof requestSchemas.skillResourceRequestSchema>;

export type SkillPathRequest = z.infer<typeof requestSchemas.skillPathRequestSchema>;

export interface SkillPathMutationResponse {
	path: string;
	reload: PiResourceReloadSummary;
}

export type SkillProjectRequest = z.infer<typeof requestSchemas.skillProjectRequestSchema>;

/** Read cap for skill content: /skill:name injects SKILL.md into the prompt as ordinary message
 * text, and UTF-8 needs at most 4 bytes per char, so this admits every skill that could flow
 * through that pipeline. */
export const SKILL_CONTENT_MAX_BYTES = 4 * SESSION_MESSAGE_TEXT_MAX_CHARS;
/** Per-file read cap for skill companion text (1 MiB); ample for scripts/references, keeps resource previews from blowing up IPC. */
export const SKILL_RESOURCE_CONTENT_MAX_BYTES = 1024 * 1024;
/** Relative-path cap for skill companion resources (4 KiB); absolute paths are not accepted. */
export const SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS = 4 * 1024;
/** Enumeration cap for skill companion resources; explicitly truncated beyond this so large directories don't block. */
export const SKILL_RESOURCE_MAX_ENTRIES = 256;
/** Path cap for extra skill directories: shares {@link ABSOLUTE_PATH_MAX_CHARS}, keeping unbounded paths off the bridge. */
export const SKILL_EXTRA_PATH_MAX_CHARS = ABSOLUTE_PATH_MAX_CHARS;
