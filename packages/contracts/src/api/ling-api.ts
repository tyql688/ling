import type {
	AppPlatform,
	SystemPermissionState,
	SystemPermissionTarget,
	ThemeSource,
	UiLanguage,
} from "../application";
import type { GlobalInstructionKind, GlobalInstructionLocation } from "../global-instructions";
import type {
	OpenProjectInfo,
	ProjectDroppedFileReferenceResult,
	ProjectRevealEntryRequest,
	ProjectRevealFileReferenceRequest,
} from "../project";
import type { ExtensionTerminalInputReplayRequest } from "../session-extension-ui";
import type { RevealSkillRequest, SkillPathMutationResponse, SkillResourceRequest } from "../skill";
import type { UpdateEvent, UpdateState } from "../update";
import type { ShellCapabilities, ShellNotificationPermission } from "./shell-api";
import type { HostApi } from "./host-procedures";
export type LingApi = Omit<
	HostApi,
	| "app"
	| "env"
	| "ui"
	| "window"
	| "project"
	| "skills"
	| "theme"
	| "skins"
	| "updates"
	| "globalInstructions"
	| "session"
> & {
	app: Omit<
		HostApi["app"],
		| "openExternal"
		| "getNotificationPermission"
		| "requestNotificationPermission"
		| "getSystemPermission"
		| "requestSystemPermission"
		| "openSystemPermission"
	> & {
		openExternal(url: string): Promise<void>;
		openPath(path: string): Promise<void>;
		getNotificationPermission(): Promise<ShellNotificationPermission>;
		requestNotificationPermission(): Promise<ShellNotificationPermission>;
		getSystemPermission(target: SystemPermissionTarget): Promise<SystemPermissionState>;
		requestSystemPermission(target: SystemPermissionTarget): Promise<SystemPermissionState>;
		openSystemPermission(target: SystemPermissionTarget): Promise<void>;
	};
	env: { home: string | null; platform: AppPlatform };
	ui: { translucent: boolean; capabilities: ShellCapabilities };
	window: { setZoomFactor(factor: number): Promise<void>; setLanguage(language: UiLanguage): Promise<void> };
	project: Omit<HostApi["project"], "add" | "resolveDroppedFileReferences" | "revealFileReference" | "revealEntry"> & {
		add(): Promise<OpenProjectInfo | null>;
		resolveDroppedFileReferences(cwd: string, files: File[]): Promise<ProjectDroppedFileReferenceResult[]>;
		revealFileReference(request: ProjectRevealFileReferenceRequest): Promise<void>;
		revealEntry(request: ProjectRevealEntryRequest): Promise<void>;
	};
	skills: Omit<HostApi["skills"], "reveal" | "revealResource" | "openGlobalDir" | "addPath"> & {
		reveal(request: RevealSkillRequest): Promise<void>;
		revealResource(request: SkillResourceRequest): Promise<void>;
		openGlobalDir(): Promise<void>;
		addPath(): Promise<SkillPathMutationResponse | null>;
	};
	theme: { set(source: ThemeSource, foreground: string | null): Promise<void> };
	skins: Omit<HostApi["skins"], "openDir"> & { openDir(): Promise<{ dir: string }> };
	updates: {
		getState(): Promise<UpdateState>;
		check(): Promise<void>;
		download(): Promise<void>;
		install(): Promise<void>;
		onEvent(callback: (event: UpdateEvent) => void): () => void;
	};
	globalInstructions: Omit<HostApi["globalInstructions"], "reveal" | "openDir"> & {
		reveal(kind: GlobalInstructionKind): Promise<GlobalInstructionLocation>;
		openDir(): Promise<{ dir: string }>;
	};
	session: HostApi["session"] & {
		replayExtensionTerminalInput(request: ExtensionTerminalInputReplayRequest): Promise<void>;
	};
};
