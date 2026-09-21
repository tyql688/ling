import type { SkillProvenance } from "@ling/contracts/skill";
import { join } from "node:path";
import { createLogger } from "../../logger";
import { globalSkillLockPath, readSkillLock } from "../../skills/skill-lock";

const log = createLogger("skill-provenance");

/** Written next to a project's skills, so it travels with the repository. */
const PROJECT_LOCK_FILE = "skills-lock.json";

export type SkillProvenanceIndex = ReadonlyMap<string, SkillProvenance>;

const EMPTY: SkillProvenanceIndex = new Map();

/** Optional labels from the external Skills CLI ledger. Read failures are logged; unrelated
 * skills remain visible, and malformed entries cannot discard other source labels. */
function readLock(filePath: string): SkillProvenanceIndex {
	let skills: Record<string, unknown> | undefined;
	try {
		skills = readSkillLock(filePath);
	} catch (error) {
		log.warn(`could not read the skills lock at ${filePath}:`, error);
		return EMPTY;
	}
	if (skills === undefined) return EMPTY;
	const index = new Map<string, SkillProvenance>();
	for (const [name, value] of Object.entries(skills)) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as { source?: unknown };
		if (typeof entry.source !== "string" || entry.source.length === 0) continue;
		index.set(name, { source: entry.source });
	}
	return index;
}

export function readGlobalSkillProvenance(): SkillProvenanceIndex {
	return readLock(globalSkillLockPath());
}

export function readProjectSkillProvenance(cwd: string): SkillProvenanceIndex {
	return readLock(join(cwd, PROJECT_LOCK_FILE));
}
