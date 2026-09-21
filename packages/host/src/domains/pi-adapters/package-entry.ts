import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readUtf8FileBounded } from "@ling/core/store/atomic-file-store";
import { z } from "zod";

const manifestSchema = z.object({ pi: z.object({ extensions: z.array(z.string()) }) });

/**
 * Finds a bundled Pi package in the Host's own dependencies. Pi loads the entry from the installed
 * location because bundling would relocate `import.meta.url` and break package assets.
 */
export async function resolvePiPackageEntry(name: string, extension: string): Promise<string> {
	for (const modules of createRequire(import.meta.url).resolve.paths(name) ?? []) {
		const directory = join(modules, name);
		const manifest = await readUtf8FileBounded(join(directory, "package.json"), 256 * 1024);
		if (manifest === undefined) continue;
		const entry = resolve(directory, extension);
		if (
			!manifestSchema
				.parse(JSON.parse(manifest))
				.pi.extensions.some((declared) => resolve(directory, declared) === entry)
		)
			throw new Error(`Package does not declare Pi extension: ${name}/${extension}`);
		return entry;
	}
	throw new Error(`Cannot locate Pi package: ${name}`);
}
