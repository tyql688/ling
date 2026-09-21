import { lingErrorDtoSchema } from "@ling/contracts/ling-error";
import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import {
	type PluginProgressEvent,
	type PluginPackageScope as SharedPluginPackageScope,
	PLUGIN_SOURCE_LIST_MAX_ITEMS,
	PLUGIN_SOURCE_MAX_CHARS,
} from "@ling/contracts/plugin";
import { assertJsonFrameSize } from "@ling/core/json-frame";
import { z } from "zod";

/**
 * Versioned, method-specific transport between Main and the package utility process.
 * Pi SDK objects never cross this boundary.
 */

/** Plugin host frame protocol version; bumping makes old subprocess handshakes fail deliberately. */
export const PLUGIN_HOST_PROTOCOL_VERSION = 5 as const;
export const PLUGIN_HOST_SYSTEM_PROXY_FALLBACK_ENV = "LING_PLUGIN_HOST_SYSTEM_PROXY_FALLBACK";
/** Host request frame limit (64Ki); requests carry only small fields like cwd/method. */
const PLUGIN_HOST_REQUEST_MAX_BYTES = 64 * 1024;
/** Host response frame limit (8MiB); list/inventory can be large, anything bigger is rejected before parsing to prevent OOM. */
export const PLUGIN_HOST_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export type PluginPackageScope = SharedPluginPackageScope;

const scopeSchema = z.enum(["global", "project"]);
const requestBase = {
	protocolVersion: z.literal(PLUGIN_HOST_PROTOCOL_VERSION),

	cwd: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS),
	deadlineAt: z.number().int().positive(),
};

const pluginHostRequestSchema = z.discriminatedUnion("method", [
	z.strictObject({ ...requestBase, method: z.literal("resolve"), projectTrusted: z.boolean() }),
	z.strictObject({ ...requestBase, method: z.literal("checkUpdates"), projectTrusted: z.boolean() }),
	z.strictObject({
		...requestBase,
		method: z.literal("install"),
		source: z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS),
		scope: scopeSchema,
	}),
	z.strictObject({
		...requestBase,
		method: z.literal("remove"),
		source: z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS),
		scope: scopeSchema,
	}),
	z.strictObject({
		...requestBase,
		method: z.literal("update"),
		source: z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS).nullable(),
		scope: z.union([scopeSchema, z.literal("all")]),
		projectTrusted: z.boolean(),
	}),
]);

const configuredPackageSchema = z.strictObject({
	source: z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS),
	scope: scopeSchema,
	filtered: z.boolean(),
	installedPath: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS).nullable(),
});
const updateSchema = z.strictObject({
	source: z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS),
	displayName: z.string().min(1).max(1_024),
	type: z.enum(["npm", "git"]),
	scope: scopeSchema,
});
const resolvedResourceSchema = z.strictObject({
	kind: z.enum(["extension", "skill", "prompt", "theme"]),
	path: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS),
	enabled: z.boolean(),
	metadata: z.strictObject({
		source: z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS),
		scope: z.enum(["global", "project", "temporary"]),
		origin: z.enum(["package", "topLevel"]),
		baseDir: z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS).nullable(),
	}),
});
const inventorySchema = z.strictObject({
	configuredPackages: z.array(configuredPackageSchema).max(PLUGIN_SOURCE_LIST_MAX_ITEMS),
	resources: z.array(resolvedResourceSchema).max(20_000),
	missingSources: z.array(z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS)).max(PLUGIN_SOURCE_LIST_MAX_ITEMS),
});
const mutationResultSchema = z.strictObject({
	completed: z.literal(true),
	settingsChanged: z.enum(["changed", "unchanged", "unknown"]),
	scopePrecision: z.enum(["exact", "piIdentityWide"]),
});
const progressEventSchema: z.ZodType<PluginProgressEvent> = z.strictObject({
	type: z.enum(["start", "progress", "complete", "error"]),
	action: z.enum(["install", "remove", "update", "clone", "pull"]),
	source: z.string().min(1).max(PLUGIN_SOURCE_MAX_CHARS),
	message: z.string().max(2_000).optional(),
});
const errorSchema = z.strictObject({
	code: z.enum(["INVALID_REQUEST", "REQUEST_DEADLINE_EXCEEDED", "PI_PACKAGE_OPERATION_FAILED"]),
	message: z.string().min(1).max(2_000),
	retryable: z.boolean(),
	outcome: z.enum(["knownFailed", "unknown"]),
	cause: lingErrorDtoSchema.optional(),
});
const responseSchema = z.discriminatedUnion("kind", [
	z.discriminatedUnion("method", [
		z.strictObject({
			kind: z.literal("result"),

			method: z.literal("resolve"),
			result: inventorySchema,
		}),
		z.strictObject({
			kind: z.literal("result"),

			method: z.literal("checkUpdates"),
			result: z.strictObject({ updates: z.array(updateSchema).max(PLUGIN_SOURCE_LIST_MAX_ITEMS) }),
		}),
		z.strictObject({
			kind: z.literal("result"),

			method: z.literal("install"),
			result: mutationResultSchema,
		}),
		z.strictObject({
			kind: z.literal("result"),

			method: z.literal("remove"),
			result: mutationResultSchema,
		}),
		z.strictObject({
			kind: z.literal("result"),

			method: z.literal("update"),
			result: mutationResultSchema,
		}),
	]),
	z.strictObject({
		kind: z.literal("error"),

		method: z.enum(["resolve", "checkUpdates", "install", "remove", "update"]),
		error: errorSchema,
	}),
]);

export type PluginHostRequestPayload = z.infer<typeof pluginHostRequestSchema>;
export type PluginHostRequest = PluginHostRequestPayload;
export type ConfiguredPluginPackage = z.infer<typeof configuredPackageSchema>;
export type PluginUpdate = z.infer<typeof updateSchema>;
export type PluginResolvedResource = z.infer<typeof resolvedResourceSchema>;
export type PluginResolvedInventory = z.infer<typeof inventorySchema>;
export type PluginMutationHostResult = z.infer<typeof mutationResultSchema>;
export type PluginHostErrorDto = z.infer<typeof errorSchema>;
export type PluginHostResponse = z.infer<typeof responseSchema>;
export type PluginHostEvent = z.infer<typeof eventSchema>;

export function parsePluginHostRequest(value: unknown): PluginHostRequest {
	assertJsonFrameSize(value, PLUGIN_HOST_REQUEST_MAX_BYTES, "Plugin host request");
	return pluginHostRequestSchema.parse(value);
}

export function parsePluginHostResponse(value: unknown): PluginHostResponse {
	assertJsonFrameSize(value, PLUGIN_HOST_RESPONSE_MAX_BYTES, "Plugin host response");
	return responseSchema.parse(value);
}

const eventSchema = z.strictObject({
	kind: z.literal("progress"),
	id: z.string().min(1).max(128),
	event: progressEventSchema,
});
export function parsePluginHostEvent(value: unknown): PluginHostEvent {
	assertJsonFrameSize(value, PLUGIN_HOST_RESPONSE_MAX_BYTES, "Plugin host event");
	return eventSchema.parse(value);
}

/** Transport abstraction keeps Core shell-agnostic. */
export interface PluginHostTransport {
	postMessage(message: unknown): void | Promise<void>;
	onMessage(listener: (message: unknown) => void): () => void;
	onExit(listener: (code: number | undefined) => void): void;
	kill(): Promise<void>;
}

export type PluginHostSpawner = () => PluginHostTransport;
