import type { ProjectFileReferenceTarget } from "./project";

/** Optional UTF-16 position in the expanded message; absent on legacy trailing references. */
export type MessageFileReference = ProjectFileReferenceTarget & { textOffset?: number };

export function fileReferenceLine(reference: ProjectFileReferenceTarget): string {
	if (reference.scope !== "project" || reference.lineRange === undefined) return `@${reference.path}`;
	const { start, end } = reference.lineRange;
	// The model receives a natural-language line range; it reads the file by line to locate the selection.
	return start === end ? `@${reference.path} (line ${start})` : `@${reference.path} (lines ${start}-${end})`;
}

function fileReferenceSuffix(references: readonly ProjectFileReferenceTarget[]): string {
	return references.map(fileReferenceLine).join("\n");
}

export function mergeFileReferenceTargets(
	submitted: string | null,
	references: readonly ProjectFileReferenceTarget[],
): string | null {
	if (references.length === 0) return submitted;
	const suffix = fileReferenceSuffix(references);
	return submitted === null ? suffix : `${submitted}\n${suffix}`;
}

/** Project message references back into the draft while preserving literal lookalikes in author text. */
export function projectFileReferenceTargets(
	text: string,
	references: readonly MessageFileReference[],
): { text: string; offsets: number[] } {
	if (references.length === 0) return { text, offsets: [] };
	if (references.some((reference) => reference.textOffset !== undefined)) {
		let from = 0,
			body = "";
		const offsets: number[] = [];
		for (const reference of references) {
			const offset = reference.textOffset;
			const token = fileReferenceLine(reference);
			if (
				offset === undefined ||
				!Number.isSafeInteger(offset) ||
				offset < from ||
				text.slice(offset, offset + token.length) !== token
			)
				throw new Error("Inline file reference metadata does not match its message text");
			body += text.slice(from, offset);
			offsets.push(body.length);
			from = offset + token.length;
		}
		return { text: body + text.slice(from), offsets };
	}
	const suffix = fileReferenceSuffix(references);
	if (text === suffix) return { text: "", offsets: references.map(() => 0) };
	const marker = `\n${suffix}`;
	if (!text.endsWith(marker)) throw new Error("Queued file reference metadata does not match its message text");
	const body = text.slice(0, -marker.length);
	return { text: body, offsets: references.map(() => body.length) };
}

export function stripFileReferenceTargets(text: string, references: readonly MessageFileReference[]): string {
	return projectFileReferenceTargets(text, references).text;
}
