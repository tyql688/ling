import type { SkillUpdateStatus } from "@ling/contracts/skill";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readUtf8FileSyncBounded } from "../store/atomic-file-store";

/** Skills CLI ledgers hold small records; 4 MiB bounds both provenance and update reads. */
const LOCK_MAX_BYTES = 4 * 1024 * 1024;
const lockSchema = z.object({ skills: z.record(z.string(), z.unknown()) });

/** Mirrors the CLI's own resolution: XDG state first, then the shared agent directory. */
export function globalSkillLockPath(): string {
	const xdgStateHome = process.env.XDG_STATE_HOME;
	return xdgStateHome
		? join(xdgStateHome, "skills", ".skill-lock.json")
		: join(homedir(), ".agents", ".skill-lock.json");
}

/** An absent CLI ledger is legitimate; unreadable or malformed data remains a failed read. */
export function readSkillLock(filePath: string): Record<string, unknown> | undefined {
	const contents = readUtf8FileSyncBounded(filePath, LOCK_MAX_BYTES);
	return contents === undefined ? undefined : lockSchema.parse(JSON.parse(contents)).skills;
}

// Older CLI installs omit tracking fields. Absence means untracked, while a wrong type is corrupt.
const entrySchema = z.object({
	source: z.string().default(""),
	sourceType: z.string().default(""),
	skillPath: z.string().default(""),
	skillFolderHash: z.string().default(""),
	ref: z
		.string()
		.nullish()
		.transform((ref) => (ref === undefined || ref === "" ? null : ref)),
});

export type SkillLockEntry = z.infer<typeof entrySchema> & { name: string };

export function readGlobalSkillUpdateEntries(): {
	entries: SkillLockEntry[];
	invalidStatuses: SkillUpdateStatus[];
} {
	const skills = readSkillLock(globalSkillLockPath());
	const entries: SkillLockEntry[] = [];
	const invalidStatuses: SkillUpdateStatus[] = [];
	for (const [name, value] of Object.entries(skills ?? {})) {
		const parsed = entrySchema.safeParse(value);
		const validName = name.length > 0 && name !== "." && name !== ".." && !/[\0/\\]/.test(name);
		if (validName && parsed.success) {
			entries.push({ name, ...parsed.data });
			continue;
		}
		invalidStatuses.push({
			name,
			source:
				validName &&
				typeof value === "object" &&
				value !== null &&
				"source" in value &&
				typeof value.source === "string"
					? value.source
					: "",
			status: "error",
			dirty: null,
			reason: validName ? "invalid skills lock entry" : "invalid skill directory name in skills lock",
		});
	}
	return { entries, invalidStatuses };
}
