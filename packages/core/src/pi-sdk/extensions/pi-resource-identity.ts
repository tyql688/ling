import type { PiAgentSessionServices } from "../types";
import type { PiToolOrigin } from "@ling/contracts/pi-tool-origin";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { readUtf8FileBounded } from "../../store/atomic-file-store";
import { toError } from "../../ling-error";
import { z } from "zod";

type SourceInfo = ReturnType<
	PiAgentSessionServices["resourceLoader"]["getExtensions"]
>["extensions"][number]["sourceInfo"];

export interface PiExtensionIdentity extends PiToolOrigin {
	path: string;
	baseDir: string | null;
	tools: string[];
	error: string | null;
}

async function readPiResourceIdentity(path: string, source: SourceInfo): Promise<PiExtensionIdentity> {
	const record: PiExtensionIdentity = {
		path,
		source: source.origin === "top-level" ? path : source.source,
		scope: source.scope === "user" ? "global" : source.scope,
		// Pi's top-level baseDir can be the entire credential/session profile. It is not an extension source root.
		extension:
			source.origin === "package" && source.baseDir
				? relative(source.baseDir, path).replaceAll("\\", "/")
				: basename(path),
		baseDir: source.origin === "package" ? (source.baseDir ?? null) : dirname(path),
		version: null,
		revision: "",
		tools: [],
		error: null,
	};
	try {
		const file = await readUtf8FileBounded(path, 2 * 1_024 * 1_024);
		if (file === undefined) throw new Error("Pi extension source no longer exists");
		record.revision = createHash("sha256").update(file).digest("hex");
		if (source.origin === "package") {
			let directory = dirname(path);
			while (true) {
				const manifest = await readUtf8FileBounded(join(directory, "package.json"), 256 * 1_024);
				if (manifest !== undefined) {
					const value = z.object({ version: z.string().optional() }).parse(JSON.parse(manifest) as unknown);
					if (value.version) {
						record.version = value.version;
						break;
					}
				}
				const parent = dirname(directory);
				if (parent === directory || directory === source.baseDir) break;
				directory = parent;
			}
		}
	} catch (error) {
		record.error = toError(error).message;
	}
	return record;
}

/** Reads the loaded Pi extension inventory with each tool attributed to the extension that registered it first. */
export async function readPiExtensionIdentities(services: PiAgentSessionServices): Promise<PiExtensionIdentity[]> {
	const result: PiExtensionIdentity[] = [];
	const tools = new Set<string>();
	for (const extension of services.resourceLoader.getExtensions().extensions) {
		const ownedTools = [...extension.tools.keys()].filter((name) => {
			if (tools.has(name)) return false;
			tools.add(name);
			return true;
		});
		if (extension.hidden || extension.resolvedPath.startsWith("<")) continue;
		const record = await readPiResourceIdentity(extension.resolvedPath, extension.sourceInfo);
		record.tools = ownedTools;
		result.push(record);
	}
	return result;
}
