import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { MCP_CONFIG_MAX_BYTES, mcpConfigSchema, mcpServerSchema, type McpWriteRequest } from "@ling/contracts/mcp";
import { createAtomicFileStore, readUtf8FileBoundedPreserveBom } from "../../store/atomic-file-store";
import { createLingError } from "../../ling-error";

function parseConfig(source: string) {
	if (source.startsWith("\uFEFF"))
		throw new Error("Pi MCP configuration requires UTF-8 without a BOM. Repair the file before saving.");
	const errors: ParseError[] = [];
	const value: unknown = parse(source, errors, { allowTrailingComma: true, allowEmptyContent: true });
	if (errors.length) throw new Error(`Invalid MCP JSON at offset ${errors[0]!.offset}. Repair the file before saving.`);
	// Upstream treats an empty or comments-only document as an unconfigured source.
	return mcpConfigSchema.parse(value === undefined ? {} : value);
}

function revision(source: string | undefined): string {
	return createHash("sha256")
		.update(source === undefined ? "missing\0" : `present\0${source}`)
		.digest("hex");
}

/** Edits one server under a file lock without reconstructing other services, secrets or comments. */
export function createMcpConfigFile(path: string) {
	const store = createAtomicFileStore({
		getPath: () => path,
		lockPath: "target",
		maxBytes: MCP_CONFIG_MAX_BYTES,
		create: () => ({ text: "{}\n" }),
		// The transaction validates the original source, including any BOM.
		parse: (source) => ({ text: source }),
		serialize: (value) => value.text,
	});
	return {
		async read(signal?: AbortSignal) {
			const source = await readUtf8FileBoundedPreserveBom(path, MCP_CONFIG_MAX_BYTES, signal);
			// Absence is a new configuration; malformed existing files never become empty settings.
			const config = source === undefined ? {} : parseConfig(source);
			return {
				exists: source !== undefined,
				revision: revision(source),
				servers: config.mcpServers ?? config["mcp-servers"] ?? {},
			};
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
					const path = [
						config.mcpServers === undefined && config["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers",
						input.name,
					];
					const change = input.change;
					const entry = (config.mcpServers ?? config["mcp-servers"])?.[input.name];
					if (change.kind === "reset-disabled" && entry?.disabled === undefined)
						return { commit: false, result: false };
					// An empty override still shadows provenance. Remove it when its only setting is reset.
					const resetProperty = change.kind === "reset-disabled" && Object.keys(entry!).length > 1;
					let replacement = change.kind === "save" ? change.server : undefined;
					if (change.kind === "patch") {
						const targetChanged =
							entry &&
							(["url", "command", "socket"] as const).some(
								(field) => change.server[field] !== undefined && change.server[field] !== entry[field],
							);
						if (targetChanged) {
							// These values can carry credentials bound to the old connection. A patch must
							// explicitly clear them before providing replacements for another endpoint/process.
							const retained = [
								"args",
								"env",
								"headers",
								"auth",
								"oauth",
								"bearerToken",
								"bearerTokenEnv",
								"bearerTokenStore",
								"requestHeadersCommand",
								"caFile",
								"literalEnv",
							].filter((field) => Object.hasOwn(entry, field) && !change.removeFields.includes(field));
							if (retained.length)
								throw createLingError({
									code: "INVALID_REQUEST",
									category: "validation",
									retryable: false,
									message: `Changing the MCP connection target requires explicit removeFields for: ${retained.join(", ")}. Supply replacement values only for the new target.`,
								});
						}
						const base = { ...entry };
						for (const field of change.removeFields) delete base[field];
						const merged = { ...base, ...change.server };
						for (const field of ["env", "headers"] as const)
							if (change.server[field]) merged[field] = { ...base[field], ...change.server[field] };
						// Match the form's opt-in approval default for a newly configured service.
						if (
							!(entry?.command || entry?.url || entry?.socket) &&
							(merged.command || merged.url || merged.socket) &&
							merged.approveTools === undefined
						)
							merged.approveTools = true;
						replacement = mcpServerSchema.parse(merged);
					}
					// Preserve the original JSONC and skip resource reconstruction when the
					// submitted values are unchanged, including reordered object properties.
					if (
						((change.kind === "save" || change.kind === "patch") && isDeepStrictEqual(entry, replacement)) ||
						(change.kind === "toggle" && entry?.disabled === change.disabled) ||
						(change.kind === "remove" && entry === undefined)
					)
						return { commit: false, result: false };
					const edits = modify(
						value.text,
						change.kind === "toggle" || resetProperty ? [...path, "disabled"] : path,
						change.kind === "toggle" ? change.disabled : replacement,
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
