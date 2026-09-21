import { applyPatch, parsePatch, reversePatch } from "diff";
import { createHash } from "node:crypto";

export interface ReviewTextSides {
	original: string;
	modified: string;
}

/** Restore omitted context only when both complete sides match the patch's Git blob identities. */
export function restoreReviewTextSides(patch: string, candidate: string): ReviewTextSides | null {
	const identities = /^index ([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})(?: [0-7]{6})?\r?$/m.exec(patch);
	if (identities === null) return null;
	const originalId = identities[1]!;
	const modifiedId = identities[2]!;
	const patches = parsePatch(patch);
	const parsed = patches[0];
	if (patches.length !== 1 || parsed === undefined || parsed.isBinary || parsed.hunks.length === 0) return null;
	for (const algorithm of ["sha1", "sha256"]) {
		const matches = (text: string, id: string): boolean => {
			// Git uses all-zero ids for the absent side of additions and deletions.
			if (/^0+$/.test(id)) return text === "";
			const bytes = Buffer.from(text, "utf8");
			return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex").startsWith(id);
		};
		if (matches(candidate, originalId)) {
			const modified = applyPatch(candidate, parsed, { autoConvertLineEndings: false });
			if (modified !== false && matches(modified, modifiedId)) return { original: candidate, modified };
		}
		if (matches(candidate, modifiedId)) {
			const original = applyPatch(candidate, reversePatch(parsed), { autoConvertLineEndings: false });
			if (original !== false && matches(original, originalId)) return { original, modified: candidate };
		}
	}
	return null;
}
