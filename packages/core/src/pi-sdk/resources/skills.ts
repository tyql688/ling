import { looksBinary } from "../../binary-detection";
import {
	type LingSkillResources,
	isBuiltinSkillPath,
	loadBuiltinSkills,
	readLingSkillsConfig,
	writeLingSkillsConfig,
} from "./skill-toggles";
import {
	type SkillInfo,
	type SkillResourceInfo,
	type SkillResourceKind,
	type SkillResourcesSnapshot,
	type SkillsOverview,
	SKILL_CONTENT_MAX_BYTES,
	SKILL_EXTRA_PATH_MAX_CHARS,
	SKILL_RESOURCE_CONTENT_MAX_BYTES,
	SKILL_RESOURCE_MAX_ENTRIES,
	SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS,
} from "@ling/contracts/skill";
import { readUtf8FileSyncBounded } from "@ling/core/store/atomic-file-store";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PiAgentSessionServices, PiResourceLoader } from "../types";
import { readGlobalSkillProvenance, readProjectSkillProvenance, type SkillProvenanceIndex } from "./skill-provenance";
import type { PiSettings } from "../settings/settings";

type PiLoadedSkill = ReturnType<PiResourceLoader["getSkills"]>["skills"][number];
type PiSkillDiagnostic = ReturnType<PiResourceLoader["getSkills"]>["diagnostics"][number];

/**
 * A collision is Pi's shadowing mechanism at work (first root wins; a user or project skill
 * overriding a built-in is the intended use), so it is reported as plain information naming
 * the winner rather than as Pi's bare `name "x" collision`.
 */
function toSkillDiagnostic(diagnostic: PiSkillDiagnostic): SkillsOverview["diagnostics"][number] {
	const message =
		diagnostic.type === "collision" && diagnostic.collision
			? `"${diagnostic.collision.name}" is shadowed by ${diagnostic.collision.winnerPath}`
			: diagnostic.message;
	return { type: diagnostic.type, message, path: diagnostic.path ?? null };
}

function toSkillInfo(skill: PiLoadedSkill, cwd: string, enabled: boolean): SkillInfo {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		source: skill.sourceInfo.source,
		scope: skill.sourceInfo.scope,
		origin: skill.sourceInfo.origin,
		projectCwd: skill.sourceInfo.scope === "project" ? cwd : null,
		builtin: isBuiltinSkillPath(skill.filePath),
		enabled,
		disableModelInvocation: skill.disableModelInvocation,
	};
}

/**
 * Labels each skill with the repository the `skills` CLI installed it from. Built-ins ship with
 * the app and package resources already carry their package as their source, so neither is looked
 * up: a coincidental name match in the ledger must not relabel them. Project skills are matched
 * against their own project's ledger, everything else against the global one.
 */
function attachProvenance(skills: SkillInfo[]): void {
	let global: SkillProvenanceIndex | null = null;
	const byProject = new Map<string, SkillProvenanceIndex>();
	for (const skill of skills) {
		if (skill.builtin || skill.origin === "package") continue;
		let index: SkillProvenanceIndex;
		if (skill.scope === "project" && skill.projectCwd !== null) {
			index = byProject.get(skill.projectCwd) ?? readProjectSkillProvenance(skill.projectCwd);
			byProject.set(skill.projectCwd, index);
		} else {
			global ??= readGlobalSkillProvenance();
			index = global;
		}
		const provenance = index.get(skill.name);
		if (provenance) skill.provenance = provenance;
	}
}

function readConfiguredSkillPaths(settings: Record<string, unknown>): string[] {
	const value = settings.skills;
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error("Pi settings 'skills' must be an array of paths");
	}
	return value as string[];
}

function assertSkillExtraPath(path: string): void {
	if (path.length === 0 || path.length > SKILL_EXTRA_PATH_MAX_CHARS || path.includes("\0")) {
		throw new Error("Invalid skill directory path");
	}
}

/** Raw SKILL.md text for the detail view. Callers must pass a filePath from the current
 * overview; this only enforces the message-pipeline size boundary. */
export function readPiSkillContent(filePath: string): string {
	const contents = readUtf8FileSyncBounded(filePath, SKILL_CONTENT_MAX_BYTES);
	if (contents === undefined) throw new Error(`Skill file no longer exists: ${filePath}`);
	return contents;
}

const SKILL_RESOURCE_DIRECTORIES: Record<string, SkillResourceKind> = {
	scripts: "script",
	references: "reference",
	assets: "asset",
};
// Three components below scripts/references/assets allow nested companions while bounding traversal.
const SKILL_RESOURCE_MAX_DEPTH = 3;
// Inspect at most 8 KiB per resource to classify large assets without reading their full bodies.
const SKILL_RESOURCE_SNIFF_BYTES = 8 * 1024;
/** Bound directory-only or unsupported entries that do not consume the resource result limit. */
const SKILL_RESOURCE_MAX_SCANNED_ENTRIES = 10_000;

function assertContainedPath(root: string, target: string): void {
	const rel = relative(root, target);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Skill resource escapes its skill directory");
}

function resourceSegments(relativePath: string): string[] {
	if (
		relativePath.length === 0 ||
		relativePath.length > SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS ||
		relativePath.includes("\0") ||
		isAbsolute(relativePath)
	) {
		throw new Error("Invalid skill resource path");
	}
	const normalized = process.platform === "win32" ? relativePath.replaceAll("\\", "/") : relativePath;
	const segments = normalized.split("/");
	if (
		segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
		segments.length > SKILL_RESOURCE_MAX_DEPTH + 1 ||
		!Object.hasOwn(SKILL_RESOURCE_DIRECTORIES, segments[0] ?? "")
	) {
		throw new Error("Invalid skill resource path");
	}
	return segments;
}

async function skillResourceRoot(filePath: string): Promise<string | null> {
	if (basename(filePath).toLowerCase() !== "skill.md") return null;
	return realpath(dirname(filePath));
}

async function resolveSkillResource(filePath: string, relativePath: string): Promise<string> {
	const root = await skillResourceRoot(filePath);
	if (root === null) throw new Error("Flat skill files do not have attached resources");
	const segments = resourceSegments(relativePath);
	let target = root;
	for (const segment of segments) {
		target = join(target, segment);
		const info = await lstat(target);
		if (info.isSymbolicLink()) throw new Error("Skill resource symbolic links are not supported");
	}
	const canonicalTarget = await realpath(target);
	assertContainedPath(root, canonicalTarget);
	return canonicalTarget;
}

async function sniffSkillResource(filePath: string, size: number): Promise<"text" | "binary"> {
	const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const length = Math.min(size, SKILL_RESOURCE_SNIFF_BYTES);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return looksBinary(buffer.subarray(0, bytesRead)) ? "binary" : "text";
	} finally {
		await handle.close();
	}
}

/** Lists conventional resources under a directory-form Skill without following links. */
export async function listPiSkillResources(filePath: string): Promise<SkillResourcesSnapshot> {
	const root = await skillResourceRoot(filePath);
	if (root === null) return { resources: [], truncated: false };
	const rootPath = root;
	const resources: SkillResourceInfo[] = [];
	let truncated = false;
	let scannedEntryCount = 0;

	async function walk(directory: string, kind: SkillResourceKind, depth: number): Promise<void> {
		const pendingDirectories = [{ directory, depth }];
		while (pendingDirectories.length > 0) {
			if (resources.length >= SKILL_RESOURCE_MAX_ENTRIES) {
				truncated = true;
				return;
			}
			const pending = pendingDirectories.pop();
			if (pending === undefined) return;
			const entries = await opendir(pending.directory);
			for await (const entry of entries) {
				if (resources.length >= SKILL_RESOURCE_MAX_ENTRIES || scannedEntryCount >= SKILL_RESOURCE_MAX_SCANNED_ENTRIES) {
					truncated = true;
					return;
				}
				scannedEntryCount += 1;
				if (entry.isSymbolicLink()) continue;
				const target = join(pending.directory, entry.name);
				const info = await lstat(target);
				if (info.isSymbolicLink()) continue;
				const canonicalTarget = await realpath(target);
				assertContainedPath(rootPath, canonicalTarget);
				if (info.isDirectory()) {
					if (pending.depth < SKILL_RESOURCE_MAX_DEPTH - 1) {
						pendingDirectories.push({ directory: canonicalTarget, depth: pending.depth + 1 });
					} else {
						truncated = true;
					}
					continue;
				}
				if (!info.isFile()) continue;
				const relativePath = relative(rootPath, canonicalTarget);
				if (relativePath.length > SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS) {
					truncated = true;
					continue;
				}
				resources.push({
					relativePath,
					kind,
					contentKind: await sniffSkillResource(canonicalTarget, info.size),
					byteLength: info.size,
				});
			}
		}
	}

	for (const [directoryName, kind] of Object.entries(SKILL_RESOURCE_DIRECTORIES)) {
		const directory = resolve(rootPath, directoryName);
		let info;
		try {
			info = await lstat(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			continue;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) continue;
		const canonicalDirectory = await realpath(directory);
		assertContainedPath(rootPath, canonicalDirectory);
		await walk(canonicalDirectory, kind, 0);
	}
	return {
		resources: resources.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
		truncated,
	};
}

export async function readPiSkillResource(filePath: string, relativePath: string): Promise<string> {
	const target = await resolveSkillResource(filePath, relativePath);
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Skill resource is not a file");
		if (info.size > SKILL_RESOURCE_CONTENT_MAX_BYTES) {
			throw new Error(`Skill resource exceeds the ${SKILL_RESOURCE_CONTENT_MAX_BYTES}-byte preview boundary`);
		}
		const buffer = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const content = buffer.subarray(0, offset);
		if (looksBinary(content)) throw new Error("Binary skill resources cannot be previewed as text");
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} finally {
		await handle.close();
	}
}

export function resolvePiSkillResourcePath(filePath: string, relativePath: string): Promise<string> {
	return resolveSkillResource(filePath, relativePath);
}

interface PiSkillProjectAccess {
	getPiServices(cwd: string): Pick<PiAgentSessionServices, "cwd" | "resourceLoader">;
	listOpenProjectPaths(): string[];
	withOpenProject<Result>(
		cwd: string,
		operation: (services: Pick<PiAgentSessionServices, "cwd" | "resourceLoader">) => Promise<Result>,
	): Promise<Result>;
}

export function createPiSkillCatalog({
	projects,
	settings,
	agentDir,
	skillResources,
}: {
	projects: PiSkillProjectAccess;
	settings: PiSettings;
	agentDir: string;
	skillResources: LingSkillResources;
}) {
	const { readDiscoveredSkills } = skillResources;

	const { globalSettingsStore } = settings;
	const { getPiSettings } = settings;
	const { enqueueGlobalSettingsMutation } = settings.mutations;

	const { getPiServices, listOpenProjectPaths, withOpenProject } = projects;

	/** Current project skill catalog; live sessions may retain an older generation until
	 * their resource reload completes. */
	function readPiProjectSkills(cwd: string): SkillInfo[] {
		const services = getPiServices(cwd);
		const skills = services.resourceLoader.getSkills().skills.map((skill) => toSkillInfo(skill, services.cwd, true));
		attachProvenance(skills);
		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Merged skills view across every open project. Globally discovered skills (user scope,
	 * package skills) resolve to the same SKILL.md from each project's resource loader, so
	 * they are deduplicated by file path; project-scoped skills stay attached to their project.
	 * `extraPaths` reflects only the GLOBAL settings.json `skills` array — that is the list
	 * Ling can edit; project-level extras still contribute their skills to the merged list.
	 */
	async function readPiSkillsOverview(): Promise<SkillsOverview> {
		const skillsByPath = new Map<string, SkillInfo>();
		const diagnostics = new Map<string, SkillsOverview["diagnostics"][number]>();
		// Acquire every project lease synchronously from one cwd snapshot. A global
		// settings reload that starts afterward waits for all reads; a pass already in
		// progress releases every read against the same committed resource generation.
		const projectSkills = await Promise.all(
			listOpenProjectPaths().map((cwd) =>
				withOpenProject(cwd, async (services) => ({
					cwd: services.cwd,
					loaded: services.resourceLoader.getSkills(),
					discovered: readDiscoveredSkills(services.resourceLoader),
				})),
			),
		);

		for (const { cwd, loaded, discovered } of projectSkills) {
			const activePaths = new Set(loaded.skills.map((skill) => skill.filePath));
			for (const skill of discovered.skills) {
				if (skillsByPath.has(skill.filePath)) continue;
				skillsByPath.set(skill.filePath, toSkillInfo(skill, cwd, activePaths.has(skill.filePath)));
			}
			for (const diagnostic of loaded.diagnostics) {
				const entry = toSkillDiagnostic(diagnostic);
				diagnostics.set(`${entry.type}\0${entry.message}\0${entry.path ?? ""}`, entry);
			}
		}

		// Settings is a configuration catalog: keep shipped rows and their diagnostics
		// available even when the master switch is off or a project shadows a built-in.
		const globalSettings = await globalSettingsStore.read();
		const config = readLingSkillsConfig(globalSettings);
		const disabledNames = new Set(config.disabled);
		const builtinLoaded = loadBuiltinSkills(agentDir);
		for (const diagnostic of builtinLoaded.diagnostics) {
			const entry = toSkillDiagnostic(diagnostic);
			diagnostics.set(`${entry.type}\0${entry.message}\0${entry.path ?? ""}`, entry);
		}
		for (const skill of builtinLoaded.skills) {
			if (skillsByPath.has(skill.filePath)) continue;
			skillsByPath.set(skill.filePath, toSkillInfo(skill, skill.baseDir, !disabledNames.has(skill.name)));
		}

		attachProvenance([...skillsByPath.values()]);

		return {
			skills: [...skillsByPath.values()].sort((a, b) => a.name.localeCompare(b.name)),
			diagnostics: [...diagnostics.values()],
			extraPaths: readConfiguredSkillPaths(globalSettings),
			enableSkillCommands: (await getPiSettings()).enableSkillCommands,
			globalSkillsDir: join(agentDir, "skills"),
			builtinSkillsEnabled: config.builtinEnabled,
		};
	}

	/** Per-skill switch for any non-project skill (user, package, extra-path, built-in).
	 * Disabling requires a currently known name so the disabled list cannot accumulate
	 * junk; enabling accepts any name — removing a stale entry is always safe. */
	async function setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
		if (!enabled) {
			const overview = await readPiSkillsOverview();
			if (!overview.skills.some((skill) => skill.name === name && skill.scope !== "project")) {
				throw new Error(`Unknown non-project skill: ${name}`);
			}
		}
		return enqueueGlobalSettingsMutation(() =>
			globalSettingsStore.transact((settings) => {
				const config = readLingSkillsConfig(settings);
				const disabled = new Set(config.disabled);
				if (disabled.has(name) === !enabled) return { commit: false, result: false };
				if (enabled) disabled.delete(name);
				else disabled.add(name);
				writeLingSkillsConfig(settings, { ...config, disabled: [...disabled].sort() });
				return { commit: true, result: true };
			}),
		);
	}

	async function removeGlobalSkillPath(path: string): Promise<void> {
		assertSkillExtraPath(path);
		await enqueueGlobalSettingsMutation(async () => {
			await globalSettingsStore.update((settings) => {
				const paths = readConfiguredSkillPaths(settings);
				if (!paths.includes(path)) throw new Error(`Skill directory is not configured: ${path}`);
				const remaining = paths.filter((entry) => entry !== path);
				if (remaining.length === 0) delete settings.skills;
				else settings.skills = remaining;
			});
		});
	}

	/** Adds a directory to the global settings.json `skills` array. The application mutation
	 * boundary owns project/session reconciliation. Duplicates are rejected explicitly. */
	async function addGlobalSkillPath(path: string): Promise<void> {
		assertSkillExtraPath(path);
		await enqueueGlobalSettingsMutation(async () => {
			await globalSettingsStore.update((settings) => {
				const paths = readConfiguredSkillPaths(settings);
				if (paths.includes(path)) throw new Error(`Skill directory is already configured: ${path}`);
				settings.skills = [...paths, path];
			});
		});
	}

	/** Master switch for the packaged built-in skills; off means none of them load. */
	async function setBuiltinSkillsEnabled(enabled: boolean): Promise<boolean> {
		return enqueueGlobalSettingsMutation(() =>
			globalSettingsStore.transact((settings) => {
				const config = readLingSkillsConfig(settings);
				if (config.builtinEnabled === enabled) return { commit: false, result: false };
				writeLingSkillsConfig(settings, { ...config, builtinEnabled: enabled });
				return { commit: true, result: true };
			}),
		);
	}
	return {
		readPiProjectSkills,
		readPiSkillsOverview,
		setSkillEnabled,
		setBuiltinSkillsEnabled,
		addGlobalSkillPath,
		removeGlobalSkillPath,
	};
}

export type PiSkillCatalog = ReturnType<typeof createPiSkillCatalog>;
