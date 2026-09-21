import { z } from "zod";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { editorTextEditSchema, languageLimits, type EditorWorkspaceChange } from "@ling/contracts/editor-language";
import { resolveExistingProjectPath, readProjectFilePreview } from "../files/project-files";

const editSchema = z.object({
	changes: z.record(z.string(), z.array(editorTextEditSchema).max(languageLimits.items)).optional(),
	documentChanges: z
		.array(
			z.object({
				textDocument: z.object({ uri: z.string(), version: z.number().int().nullable() }),
				edits: z.array(editorTextEditSchema).max(languageLimits.items),
			}),
		)
		.max(languageLimits.editFiles)
		.optional(),
});
/** Resource operations are deliberately not advertised: this owner applies reversible text edits only. */
export async function normalizeWorkspaceEdit(
	cwd: string,
	value: unknown,
	versions: ReadonlyMap<string, number>,
	label: string,
): Promise<EditorWorkspaceChange | null> {
	if (value === null || value === undefined) return null;
	const edit = editSchema.parse(value);
	const entries = [
		...Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ uri, edits, version: versions.get(uri) ?? null })),
		...(edit.documentChanges ?? []).map((item) => ({
			uri: item.textDocument.uri,
			edits: item.edits,
			version: item.textDocument.version ?? versions.get(item.textDocument.uri) ?? null,
		})),
	];
	if (entries.length > languageLimits.editFiles) throw new Error("Too many files in one language edit");
	const files: EditorWorkspaceChange["files"] = [];
	for (const entry of entries) {
		const target = await resolveExistingProjectPath(cwd, relative(cwd, fileURLToPath(entry.uri)).replaceAll("\\", "/"));
		const path = relative(cwd, target).replaceAll("\\", "/");
		let baseRevision: string | undefined;
		if (entry.version === null) {
			const preview = await readProjectFilePreview(cwd, path);
			if (preview.kind !== "text") throw new Error(`Language edit requires a text document: ${path}`);
			baseRevision = preview.revision;
		}
		files.push({ path, version: entry.version, ...(baseRevision ? { baseRevision } : {}), edits: entry.edits });
	}
	if (new Set(files.map((file) => file.path)).size !== files.length)
		throw new Error("Language edit contains duplicate file entries");
	return { label, files };
}
