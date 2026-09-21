import type { ProjectRef } from "@ling/contracts/owner-ref";
import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import { isRecord as isDatasetRecord } from "@ling/contracts/records";
import { createLogger } from "@ling/core/logger";
import { backupFilePath, readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import { datasetCorruption, inspectDatasetVersion, parseDatasetJson } from "@ling/host/storage/dataset-envelope";
import { join } from "node:path";
import { z } from "zod";
import type { HostDatabase } from "../../storage/database";

const log = createLogger("project-store");

/** Dataset schema identifier; validated when reading from disk to prevent cross-reading other userData JSON. */
const PROJECT_DATASET_ID = "ling/project-metadata";
/** Current envelope version; a version bump must migrate the open-project list structure. */
const PROJECT_STORE_VERSION = 2;
/** Byte cap for the project list file. 2MiB holds tens of thousands of paths; beyond that it is treated as corruption/attack and refused. */
const MAX_PROJECT_STORE_BYTES = 2 * 1024 * 1024;
/** Cap on persisted open projects. 10k far exceeds a sane sidebar; more only inflates startup restore and validation. */
const MAX_OPEN_PROJECTS = 10_000;
/** Per-entry project path field cap: same source as shared {@link ABSOLUTE_PATH_MAX_CHARS}. */

interface ProjectStoreV2 {
	schema: typeof PROJECT_DATASET_ID;
	version: typeof PROJECT_STORE_VERSION;
	writtenAt: number;
	projects: ProjectRef[];
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
		throw datasetCorruption(PROJECT_DATASET_ID, `The ${label} contains unknown fields.`);
	}
}

function assertProjectPath(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > ABSOLUTE_PATH_MAX_CHARS ||
		value.includes("\0")
	) {
		throw datasetCorruption(PROJECT_DATASET_ID, `Invalid project path in ${label}.`);
	}
	return value;
}

function assertPathArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_OPEN_PROJECTS) {
		throw datasetCorruption(PROJECT_DATASET_ID, `Invalid project list in ${label}.`);
	}
	return value.map((item) => assertProjectPath(item, label));
}

function parseCurrentStore(record: Record<string, unknown>): string[] {
	assertExactKeys(record, ["schema", "version", "writtenAt", "projects"], "project metadata dataset");
	if (!Number.isSafeInteger(record.writtenAt) || (record.writtenAt as number) < 0 || !Array.isArray(record.projects)) {
		throw datasetCorruption(PROJECT_DATASET_ID, "The project metadata envelope is invalid.");
	}
	if (record.projects.length > MAX_OPEN_PROJECTS) {
		throw datasetCorruption(PROJECT_DATASET_ID, `Project metadata exceeds ${MAX_OPEN_PROJECTS} entries.`);
	}
	return record.projects.map((project, index) => {
		if (!isDatasetRecord(project)) {
			throw datasetCorruption(PROJECT_DATASET_ID, `Project metadata entry ${index} is invalid.`);
		}
		assertExactKeys(project, ["cwd"], `project metadata entry ${index}`);
		return assertProjectPath(project.cwd, `project metadata entry ${index}`);
	});
}

function parseOpenProjectPaths(contents: string): string[] {
	const value = parseDatasetJson(contents, PROJECT_DATASET_ID);
	if (!isDatasetRecord(value)) throw datasetCorruption(PROJECT_DATASET_ID, "Project metadata must be a JSON object.");
	inspectDatasetVersion(value, {
		datasetId: PROJECT_DATASET_ID,
		schema: PROJECT_DATASET_ID,
		currentVersion: PROJECT_STORE_VERSION,
	});
	return parseCurrentStore(value);
}

function serializeOpenProjectPaths(paths: string[], writtenAt = Date.now()): string {
	const uniquePaths = [...new Set(assertPathArray(paths, "project metadata writer"))];
	if (!Number.isSafeInteger(writtenAt) || writtenAt < 0) {
		throw datasetCorruption(PROJECT_DATASET_ID, "Project metadata writtenAt is invalid.");
	}
	const shape: ProjectStoreV2 = {
		schema: PROJECT_DATASET_ID,
		version: PROJECT_STORE_VERSION,
		writtenAt,
		projects: uniquePaths.map((cwd) => ({ cwd })),
	};
	const contents = `${JSON.stringify(shape, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_PROJECT_STORE_BYTES) {
		throw datasetCorruption(PROJECT_DATASET_ID, `Project metadata exceeds ${MAX_PROJECT_STORE_BYTES} bytes.`);
	}
	return contents;
}

/** Owns project membership in SQLite; legacy files remain available for explicit recovery. */
export function createProjectStore({ userDataDir, database }: { userDataDir: string; database: HostDatabase }) {
	const path = join(userDataDir, "ling-project.json");
	function replace(paths: string[], openedAt = Date.now()) {
		serializeOpenProjectPaths(paths);
		const unique = [...new Set(paths)];
		database.transaction(() => {
			const previouslyOpen = new Set(
				database
					.all("SELECT cwd FROM projects WHERE is_open=1")
					.map((row) => z.object({ cwd: z.string() }).parse(row).cwd),
			);
			database.run("UPDATE projects SET is_open=0");
			for (const [index, cwd] of unique.entries())
				database.run(
					"INSERT INTO projects(cwd,is_open,open_order,last_opened_at) VALUES(?,1,?,?) ON CONFLICT(cwd) DO UPDATE SET is_open=1,open_order=excluded.open_order,last_opened_at=CASE WHEN ?=1 THEN excluded.last_opened_at ELSE projects.last_opened_at END",
					cwd,
					index,
					openedAt,
					previouslyOpen.has(cwd) ? 0 : 1,
				);
		});
	}
	function ensureImported() {
		database.importLegacy({
			key: PROJECT_DATASET_ID,
			source: path,
			read() {
				const contents = readUtf8FileSyncBounded(path, MAX_PROJECT_STORE_BYTES);
				return contents === undefined ? [] : parseOpenProjectPaths(contents);
			},
			// Historical project files did not record when a project was opened.
			publish: (paths) => replace(paths, 0),
		});
	}
	function readOpenProjectPaths(): string[] {
		ensureImported();
		const paths = database
			.all("SELECT cwd FROM projects WHERE is_open=1 ORDER BY open_order LIMIT ?", MAX_OPEN_PROJECTS + 1)
			.map((row) => z.object({ cwd: z.string() }).parse(row).cwd);
		serializeOpenProjectPaths(paths);
		return paths;
	}
	async function writeOpenProjectPaths(paths: string[]) {
		ensureImported();
		replace(paths);
	}
	/** Only an explicit recovery action consults this backup; failed reads never become ordinary empty success. */
	function readOpenProjectPathsBackup(): string[] | null {
		try {
			const contents = readUtf8FileSyncBounded(backupFilePath(path), MAX_PROJECT_STORE_BYTES);
			return contents === undefined ? null : parseOpenProjectPaths(contents);
		} catch (error) {
			log.error("project store backup is unusable:", error);
			return null;
		}
	}
	return {
		readOpenProjectPaths,
		writeOpenProjectPaths,
		readOpenProjectPathsBackup,
		async recoverOpenProjectPaths(paths: string[]) {
			database.transaction(() => {
				replace(paths);
				database.markImported(PROJECT_DATASET_ID, path);
			});
		},
	};
}
export type ProjectStore = ReturnType<typeof createProjectStore>;
