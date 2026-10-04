import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import {
	MCP_CONFIG_MAX_BYTES,
	mcpConfigSchema,
	mcpScopedServerSchema,
	mcpServerNamespace,
	mcpServerSchema,
	type McpTarget,
	type McpWriteRequest,
} from "@ling/contracts/mcp";
import { createAtomicFileStore, readUtf8FileBoundedPreserveBom } from "../../store/atomic-file-store";
import { createLingError } from "../../ling-error";

function parseConfig(source: string) {
	const errors: ParseError[] = [];
	const value: unknown = parse(source, errors, {
		disallowComments: true,
		allowTrailingComma: false,
		allowEmptyContent: false,
	});
	if (errors.length)
		throw new Error(
			`Official Pi MCP requires valid JSON (error at offset ${errors[0]!.offset}). Repair the file before saving.`,
		);
	return mcpConfigSchema.parse(value);
}
function revision(source: string | undefined): string {
	return createHash("sha256")
		.update(source === undefined ? "missing\0" : `present\0${source}`)
		.digest("hex");
}

/** Edits one official Pi server under a file lock, preserving unrelated fields and formatting. */
export function createMcpConfigFile(path: string, scope: McpTarget) {
	const store = createAtomicFileStore({
		getPath: () => path,
		lockPath: "target",
		maxBytes: MCP_CONFIG_MAX_BYTES,
		create: () => ({ text: "{}\n" }),
		parse: (source) => ({ text: source }),
		serialize: (value) => value.text,
	});
	return {
		async read(signal?: AbortSignal) {
			const source = await readUtf8FileBoundedPreserveBom(path, MCP_CONFIG_MAX_BYTES, signal);
			// Only a missing file is empty configuration. Pi's canonical format is strict JSON.
			const config = source === undefined ? {} : parseConfig(source);
			return { exists: source !== undefined, revision: revision(source), servers: config.mcpServers ?? {}, config };
		},
		write(input: Pick<McpWriteRequest, "expectedRevision" | "name" | "change">, signal: AbortSignal) {
			return store.transact(
				(value, context) => {
					const config = parseConfig(context.source ?? value.text);
					if (revision(context.source) !== input.expectedRevision)
						throw createLingError({
							code: "MCP_CONFIG_CHANGED",
							category: "lifecycle",
							message: "MCP configuration changed. Refresh it before saving your changes.",
							retryable: true,
							userAction: "retry",
						});
					const path = ["mcpServers", input.name];
					const change = input.change;
					const entry = config.mcpServers?.[input.name];
					let replacement =
						change.kind === "save" ? mcpScopedServerSchema.parse({ scope, server: change.server }).server : undefined;
					if (change.kind === "patch") {
						const base = entry === undefined ? {} : mcpServerSchema.parse(entry);
						const targetChanged = (["url", "command"] as const).some(
							(field) => change.server[field] !== undefined && change.server[field] !== base[field],
						);
						if (targetChanged) {
							const retained = ["args", "env", "headers", "oauth", "auth"].filter(
								(field) => Object.hasOwn(base, field) && !change.removeFields.includes(field),
							);
							if (retained.length)
								throw createLingError({
									code: "INVALID_REQUEST",
									category: "validation",
									retryable: false,
									message: `Changing the MCP connection target requires explicit removeFields for: ${retained.join(", ")}. Supply replacement values only for the new target.`,
								});
						}
						for (const field of change.removeFields) delete base[field];
						const merged = { ...base, ...change.server };
						for (const field of ["env", "headers"] as const)
							if (change.server[field]) merged[field] = { ...base[field], ...change.server[field] };
						replacement = mcpScopedServerSchema.parse({ scope, server: merged }).server;
					}
					if (change.kind === "reset-enabled" && entry === undefined) return { commit: false, result: false };
					if (change.kind === "toggle" || change.kind === "reset-enabled") {
						// Toggles retain the entry's connection or inherited project scope.
						const server = mcpScopedServerSchema.parse({ scope, server: entry }).server;
						if (change.kind === "toggle" && server.enabled === change.enabled) return { commit: false, result: false };
						if (change.kind === "reset-enabled" && server.enabled === undefined)
							return { commit: false, result: false };
					}
					if (change.kind !== "remove") {
						const conflict = Object.keys(config.mcpServers ?? {}).find(
							(name) => name !== input.name && mcpServerNamespace(name) === mcpServerNamespace(input.name),
						);
						if (conflict)
							throw new Error(
								`MCP server "${input.name}" conflicts with "${conflict}" in namespace ${mcpServerNamespace(input.name)}.`,
							);
					}
					if (
						((change.kind === "save" || change.kind === "patch") && isDeepStrictEqual(entry, replacement)) ||
						(change.kind === "remove" && entry === undefined)
					)
						return { commit: false, result: false };
					const edits = modify(
						value.text,
						change.kind === "toggle" || change.kind === "reset-enabled" ? [...path, "enabled"] : path,
						change.kind === "toggle" ? change.enabled : replacement,
						{ formattingOptions: { insertSpaces: true, tabSize: 2, eol: value.text.includes("\r\n") ? "\r\n" : "\n" } },
					);
					if (!edits.length) return { commit: false, result: false };
					const updated = applyEdits(value.text, edits);
					parseConfig(updated);
					value.text = updated;
					return { commit: true, result: true };
				},
				{ signal },
			);
		},
	};
}
