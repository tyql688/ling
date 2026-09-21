import type { z } from "zod";
import type * as requestSchemas from "./plugin-requests";
type RequestSchemasShape = ReturnType<typeof requestSchemas.createPluginRequestSchemas>;

import type { PiResourceReloadSummary } from "./session";

// A package source may be a URL/path/specifier, so it uses a 4 KiB text boundary.
// Discovery/update batches are capped at 4,096 entries across IPC and utility transport.
/** Cap on the package source string: URLs/paths/npm specifiers share 4 KiB, keeping unbounded specifiers off IPC/utility transport. */
export const PLUGIN_SOURCE_MAX_CHARS = 4_096;
/** Item cap for discovery/update batches: bounds lists crossing IPC and utility transport so one package scan can't stall the channel. */
export const PLUGIN_SOURCE_LIST_MAX_ITEMS = 4_096;

export type PluginPackageScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceInfo {
	kind: PluginResourceKind;
	name: string;
	relativePath: string;
	enabled: boolean;
}

export interface ConfiguredPackage {
	source: string;
	scope: PluginPackageScope;
	filtered: boolean;
	installedPath: string | null;
	resolution: "loaded" | "no-active-resources" | "missing";
	counts: Record<PluginResourceKind, number>;
	resources: PluginResourceInfo[];
}

export interface PluginUpdateInfo {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: PluginPackageScope;
}

export type PluginProjectRequest = z.infer<RequestSchemasShape["pluginProjectRequestSchema"]>;

export interface PluginProgressEvent {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string | undefined;
}

export type PluginMutationOperationRequest = Pick<InstallPluginRequest, "operation" | "deadlineAt" | "cwd">;

export type InstallPluginRequest = z.infer<RequestSchemasShape["installPluginRequestSchema"]>;

export type RemovePluginRequest = z.infer<RequestSchemasShape["removePluginRequestSchema"]>;

export type UpdatePluginRequest = z.infer<RequestSchemasShape["updatePluginRequestSchema"]>;

export interface PluginMutationResponse {
	requestId: string;
	reload: PiResourceReloadSummary;
}

export type CancelPluginOperationRequest = z.infer<RequestSchemasShape["cancelPluginOperationRequestSchema"]>;

export interface CancelPluginOperationResponse {
	requestId: string;
	accepted: boolean;
}
