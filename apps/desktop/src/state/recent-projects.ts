import { ABSOLUTE_PATH_MAX_CHARS, SESSION_ID_MAX_CHARS } from "@ling/contracts/path-bounds";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonStateFile } from "./atomic-state-file";

export interface RecentProject {
	cwd: string;
	sessionId: string;
}

/** Taskbar jump lists stay scannable; past a handful of entries the rest is noise. */
const RECENT_PROJECT_LIMIT = 8;
const recentProjectsSchema = z
	.array(
		z.strictObject({
			cwd: z
				.string()
				.min(1)
				.max(ABSOLUTE_PATH_MAX_CHARS)
				.refine((value) => !value.includes("\0")),
			sessionId: z.string().min(1).max(SESSION_ID_MAX_CHARS),
		}),
	)
	.max(RECENT_PROJECT_LIMIT);
/** Eight path entries stay far below any filesystem block; 16 KiB rejects corruption. */
const RECENT_PROJECTS_MAX_BYTES = 16 * 1_024;

/** Moves the project to the front and re-binds its latest viewed session; identity means no write is needed. */
export function updateRecentProjects(projects: RecentProject[], ref: RecentProject): RecentProject[] {
	const newest = projects[0];
	if (newest && newest.cwd === ref.cwd && newest.sessionId === ref.sessionId) return projects;
	const updated = [
		{ cwd: ref.cwd, sessionId: ref.sessionId },
		...projects.filter((project) => project.cwd !== ref.cwd),
	];
	return updated.slice(0, RECENT_PROJECT_LIMIT);
}

export async function loadRecentProjects(userDataDirectory: string): Promise<RecentProject[]> {
	const path = join(userDataDirectory, "recent-projects.json");
	try {
		const source = await readFile(path, "utf8");
		if (Buffer.byteLength(source) > RECENT_PROJECTS_MAX_BYTES) {
			throw new Error("Recent projects exceed their size bound");
		}
		return recentProjectsSchema.parse(JSON.parse(source) as unknown);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function saveRecentProjects(userDataDirectory: string, projects: RecentProject[]): Promise<void> {
	const validated = recentProjectsSchema.parse(projects);
	const destination = join(userDataDirectory, "recent-projects.json");
	await writeJsonStateFile(destination, validated);
}
