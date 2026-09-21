import { piToolOriginSchema, type PiToolOrigin } from "@ling/contracts/pi-tool-origin";
import { createLogger } from "../../logger";
import type { PiInlineExtension, PiSessionManager } from "../types";
import { z } from "zod";
import type { PiExtensionIdentity } from "./pi-resource-identity";

const log = createLogger("pi-tool-origin");
const entryType = "ling:pi-tool-origin:v1";
const entrySchema = z.strictObject({ toolCallId: z.string().min(1).max(200), origin: piToolOriginSchema });

/** Records the effective tool owner on its actual branch before execution; old history stays unknown. */
export function createPiToolOriginRecorder(sessionManager: PiSessionManager) {
	const tools = new Map<string, PiToolOrigin>();
	const extension: PiInlineExtension = {
		name: "ling-pi-tool-origin",
		hidden: true,
		factory(pi) {
			pi.on("tool_call", (event) => {
				const origin = tools.get(event.toolName);
				if (origin) sessionManager.appendCustomEntry(entryType, { toolCallId: event.toolCallId, origin });
			});
		},
	};
	return {
		extension,
		setResources(resources: PiExtensionIdentity[]) {
			tools.clear();
			for (const resource of resources) {
				if (resource.error || !resource.revision) continue;
				const { source, extension, scope, version, revision } = resource;
				for (const tool of resource.tools) tools.set(tool, { source, extension, scope, version, revision });
			}
		},
	};
}

/** Resolve against the result's own ancestry; providers may reuse a tool-call ID in later turns. */
export function createPiToolOrigins(sessionManager: Pick<PiSessionManager, "getSessionId" | "getLeafId" | "getEntry">) {
	const cache = new Map<string, PiToolOrigin | null>();
	return (toolCallId: string, entryId: string | null = null): PiToolOrigin | undefined => {
		const leaf = entryId ?? sessionManager.getLeafId();
		if (leaf === null) return undefined;
		const key = `${sessionManager.getSessionId()}:${leaf}:${toolCallId}`;
		if (cache.has(key)) return cache.get(key) ?? undefined;
		let current: string | null = leaf;
		let origin: PiToolOrigin | undefined;
		// Provenance belongs between an assistant call and its result, never an unbounded transcript scan.
		for (let remaining = 1024; current !== null && remaining > 0; remaining--) {
			const entry = sessionManager.getEntry(current);
			if (!entry) break;
			if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "user")) break;
			if (entry.type === "custom" && entry.customType === entryType) {
				const parsed = entrySchema.safeParse(entry.data);
				if (parsed.success && parsed.data.toolCallId === toolCallId) {
					origin = parsed.data.origin;
					break;
				}
				if (!parsed.success) log.warn(`Cannot verify Pi tool origin in entry ${entry.id}:`, parsed.error);
			}
			current = entry.parentId;
		}
		cache.set(key, origin ?? null);
		// History paging creates its own projector; this cache covers the recent live view only.
		while (cache.size > 2048) cache.delete(cache.keys().next().value!);
		return origin;
	};
}
