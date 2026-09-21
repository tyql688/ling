import type { z } from "zod";
import type { DatasetStoreStatus } from "./dataset-status";
import type { PiDiagnostic } from "./pi-diagnostic";
import type * as requestSchemas from "./project-file-requests";
import type * as projectRequestSchemas from "./project-requests";
type ProjectRequestSchemasShape = ReturnType<typeof projectRequestSchemas.createProjectRequestSchemas>;
type RequestSchemasShape = ReturnType<typeof requestSchemas.createProjectFileSchemas>;

export interface WorkspaceMeta {
	kind: "primary" | "worktree";
	rootWorkspacePath?: string;
	branchName?: string | null;
}

type ProjectAvailability = "ready" | "missing";

export interface OpenProjectInfo {
	cwd: string;
	name: string;
	availability: ProjectAvailability;
	meta: WorkspaceMeta;
	diagnostics: PiDiagnostic[];
}

export interface ProjectListFailure {
	cwd: string;
	message: string;
}

/** Project-list failures cross the Host protocol; 2,000 characters preserve normal diagnostics without allowing one tool error to inflate the response. */
export const PROJECT_LIST_FAILURE_MESSAGE_MAX_CHARS = 2_000;

/** Project inspection is entity-isolated: healthy projects remain usable while a bounded
 * representative failure keeps a partial list from masquerading as a complete success. */
export type ProjectListResult =
	| { status: "complete"; projects: OpenProjectInfo[] }
	| {
			status: "partial";
			projects: OpenProjectInfo[];
			failureCount: number;
			firstFailure: ProjectListFailure;
	  };

/** Max characters of a project-relative path; shared by workspace browse/preview requests so an overlong path can't cross IPC. */
export const PROJECT_RELATIVE_PATH_MAX_CHARS = 8 * 1_024;
/** Cap on file references in a single composer draft; also bounds the preload→main batch path-resolution fan-out. */
export const PROJECT_FILE_REFERENCE_MAX_ITEMS = 20;
/** Cap on @-mention completion corpus; shared by Git/non-Git indexes so a giant project can't amplify IPC and memory. */
export const PROJECT_FILE_INDEX_MAX_ITEMS = 50_000;
/** Max total characters of @-mention completion paths; bounds the index, its derived lowercase copy, and IPC serialization volume. */
export const PROJECT_FILE_INDEX_MAX_TOTAL_CHARS = 4 * 1_024 * 1_024;
/** Cap on entries per directory listing; large directories are truncated so a single list can't stall the explorer. */
export const PROJECT_DIRECTORY_MAX_ENTRIES = 2_000;
/** 512 KiB byte cap on text-preview reads; beyond this it returns tooLarge so a whole file isn't pulled into the renderer. */
export const PROJECT_TEXT_PREVIEW_MAX_BYTES = 512 * 1_024;
/** 10 MiB byte cap on image-preview reads; common screenshots stay previewable while huge binaries are rejected at the bridge. */
export const PROJECT_IMAGE_PREVIEW_MAX_BYTES = 10 * 1_024 * 1_024;

export type ProjectDirectoryEntryKind = "directory" | "file" | "unavailable";

/** A project-root-relative entry returned by the lazy workspace explorer. */
export interface ProjectDirectoryEntry {
	name: string;
	path: string;
	kind: ProjectDirectoryEntryKind;
	symbolicLink: boolean;
}

export type ProjectListDirectoryRequest = z.infer<RequestSchemasShape["listDirectoryRequestSchema"]>;

export interface ProjectDirectoryListing {
	path: string;
	entries: ProjectDirectoryEntry[];
	/** More entries exist but were omitted at the safe per-directory boundary. */
	truncated: boolean;
}

/** Folder choices on the Host before a project is opened; every path uses the Host's native spelling. */
export interface HostDirectoryListing {
	path: string;
	parent: string | null;
	entries: { name: string; path: string; unavailable: boolean }[];
	truncated: boolean;
}

export type ProjectReadFilePreviewRequest = z.infer<RequestSchemasShape["readFilePreviewRequestSchema"]>;

export type ProjectWriteFileRequest = z.infer<RequestSchemasShape["writeFileRequestSchema"]>;

export interface ProjectWriteFileResult {
	path: string;
	size: number;
	modifiedAt: number;
	revision: string;
}

/** Preview selection reference: 1-based, closed interval; only project files may carry one. */
export interface ProjectFileReferenceLineRange {
	start: number;
	end: number;
}

/** Composer file reference: project files use a relative path (a directory is allowed); explicitly dropped external files use a normalized absolute path. */
export type ProjectFileReferenceTarget = z.infer<RequestSchemasShape["projectFileReferenceTargetSchema"]>;

/** An @-mention completion entry; directories and files share one list, and the render layer picks the icon and display. */
export interface ProjectMentionItem {
	path: string;
	kind: "file" | "directory";
}

/** Bounded result of an OS-dropped File: preload extracts the path and main realpath-validates it. */
export type ProjectDroppedFileReferenceResult =
	{ status: "ok"; reference: ProjectFileReferenceTarget } | { status: "unavailable" };

export type ProjectRevealFileReferenceRequest = z.infer<RequestSchemasShape["revealFileReferenceRequestSchema"]>;

export type ProjectImagePreviewMime =
	"image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";

interface ProjectFilePreviewBase {
	path: string;
	size: number;
	modifiedAt: number;
}

export type ProjectFilePreview =
	| (ProjectFilePreviewBase & { kind: "text"; content: string; revision: string })
	// Pinned to ArrayBuffer rather than the default ArrayBufferLike, which also admits
	// SharedArrayBuffer and is therefore rejected as a Response/Blob body: the reader never
	// produces a shared buffer, and stating that keeps callers from re-copying the bytes.
	| (ProjectFilePreviewBase & { kind: "image"; data: Uint8Array<ArrayBuffer>; mime: ProjectImagePreviewMime })
	| (ProjectFilePreviewBase & { kind: "binary" })
	| (ProjectFilePreviewBase & { kind: "tooLarge"; maxBytes: number });

export type ProjectRevealEntryRequest = z.infer<RequestSchemasShape["revealEntryRequestSchema"]>;

/** Closed set of launchable external-app ids; settings and the launch IPC accept only these targets, blocking arbitrary executable paths from the renderer. */
export const PROJECT_LAUNCH_TARGET_IDS = [
	"file-manager",
	"nautilus",
	"dolphin",
	"thunar",
	"nemo",
	"visual-studio-code",
	"cursor",
	"zed",
	"sublime-text",
	"intellij-idea",
	"goland",
	"webstorm",
	"ghostty",
	"iterm2",
	"warp",
	"wezterm",
	"kitty",
	"alacritty",
	"system-terminal",
] as const;

export type ProjectLaunchTargetId = (typeof PROJECT_LAUNCH_TARGET_IDS)[number];
export type ProjectLaunchTargetKind = "file-manager" | "editor" | "terminal";

/** Static id→kind table; preference storage and default launch group by kind, staying consistent with the detected target list. */
export const PROJECT_LAUNCH_TARGET_KIND_BY_ID: Record<ProjectLaunchTargetId, ProjectLaunchTargetKind> = {
	"file-manager": "file-manager",
	nautilus: "file-manager",
	dolphin: "file-manager",
	thunar: "file-manager",
	nemo: "file-manager",
	"visual-studio-code": "editor",
	cursor: "editor",
	zed: "editor",
	"sublime-text": "editor",
	"intellij-idea": "editor",
	goland: "editor",
	webstorm: "editor",
	ghostty: "terminal",
	iterm2: "terminal",
	warp: "terminal",
	wezterm: "terminal",
	kitty: "terminal",
	alacritty: "terminal",
	"system-terminal": "terminal",
};

export type ProjectLaunchPreferences = Record<ProjectLaunchTargetKind, ProjectLaunchTargetId | null>;

/** An installed application that can open a project directory. */
export interface ProjectLaunchTarget {
	id: ProjectLaunchTargetId;
	kind: ProjectLaunchTargetKind;
	name: string;
}

export type ProjectLaunchRequest = z.infer<ProjectRequestSchemasShape["projectLaunchRequestSchema"]>;

export type ProjectLaunchDefaultRequest = z.infer<ProjectRequestSchemasShape["projectLaunchDefaultRequestSchema"]>;

export type ProjectStoreStatus = DatasetStoreStatus | { status: "degraded"; errorCode: "PROJECT_STORE_WRITE_FAILED" };

export type ProjectRemovalOutcome =
	{ status: "removed"; cwd: string } | { status: "removed-with-warning"; cwd: string; warning: string };

export interface ProjectTrustRequest {
	requestId: string;
	cwd: string;
}

export type ProjectTrustChoice = "trust" | "session" | "deny";

/**
 * A project's own Pi configuration, read straight from its `.pi/settings.json`.
 * `settings` is empty both when the file is missing and when the project is untrusted —
 * Pi refuses to load project settings it does not trust — so `exists` and `trusted` are
 * carried separately to tell those two very different states apart.
 */
export interface ProjectPiConfig {
	path: string;
	exists: boolean;
	trusted: boolean;
	settings: Record<string, unknown>;
}
