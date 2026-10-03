import { createPiGlobalSettingsStore } from "../settings/global-settings-store";
import { type DefaultPackageManager, loadSkills } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PiResourceLoader, PiSettingsManager } from "../types";

type PiSkillsResult = ReturnType<PiResourceLoader["getSkills"]>;

/** Ling-namespaced key in Pi's global settings.json holding the skill switches.
 * Pi's save path merges only fields it modified, so the key survives CLI-side
 * writes; an absent key means everything enabled (the shipped default). */
const LING_SKILLS_SETTINGS_KEY = "lingSkills";

interface LingSkillsConfig {
	/** Master switch for the packaged built-in skills: false unloads all of them. */
	builtinEnabled: boolean;
	/** Disabled packaged built-in skill names. */
	disabled: string[];
	legacyDisabled: string[];
}

/** Parses the `lingSkills` settings key. Absent means all enabled; a malformed
 * value is a settings-file corruption and must surface, matching the `skills` array. */
export function readLingSkillsConfig(settings: Record<string, unknown>): LingSkillsConfig {
	const value = settings[LING_SKILLS_SETTINGS_KEY];
	if (value === undefined) return { builtinEnabled: true, disabled: [], legacyDisabled: [] };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Pi settings 'lingSkills' must be an object");
	}
	const record = value as { builtinEnabled?: unknown; disabled?: unknown; legacyDisabled?: unknown };
	if (record.builtinEnabled !== undefined && typeof record.builtinEnabled !== "boolean") {
		throw new Error("Pi settings 'lingSkills.builtinEnabled' must be a boolean");
	}
	if (
		record.disabled !== undefined &&
		(!Array.isArray(record.disabled) || record.disabled.some((entry) => typeof entry !== "string"))
	) {
		throw new Error("Pi settings 'lingSkills.disabled' must be an array of skill names");
	}
	if (
		record.legacyDisabled !== undefined &&
		(!Array.isArray(record.legacyDisabled) || record.legacyDisabled.some((name) => typeof name !== "string"))
	)
		throw new Error("Pi settings lingSkills.legacyDisabled must contain names");
	return {
		builtinEnabled: record.builtinEnabled ?? true,
		disabled: (record.disabled as string[] | undefined) ?? [],
		legacyDisabled: (record.legacyDisabled as string[] | undefined) ?? (record.disabled as string[] | undefined) ?? [],
	};
}

/** Writes the switches back, normalizing the shipped default (all enabled) to an
 * absent key so untouched installs keep a clean settings.json. */
export function writeLingSkillsConfig(settings: Record<string, unknown>, config: LingSkillsConfig): void {
	if (config.builtinEnabled && config.disabled.length === 0 && config.legacyDisabled.length === 0)
		delete settings[LING_SKILLS_SETTINGS_KEY];
	else
		settings[LING_SKILLS_SETTINGS_KEY] = {
			builtinEnabled: config.builtinEnabled,
			disabled: config.disabled,
			legacyDisabled: config.legacyDisabled,
		};
}

/** Host resolves the shipped resource directory and passes it to the Pi worker.
 * An unset path means this embedding has no built-in skills. */
function builtinSkillsDir(): string | undefined {
	return process.env.LING_BUILTIN_SKILLS_DIR;
}

/** Every skill shipped in the built-in directory, regardless of switches — the
 * settings UI renders toggles from this list. A missing directory surfaces through
 * loadSkills' own path diagnostic. */
export function loadBuiltinSkills(agentDir: string): PiSkillsResult {
	const directory = builtinSkillsDir();
	if (!directory) return { skills: [], diagnostics: [] };
	return loadSkills({ cwd: directory, agentDir, skillPaths: [directory], includeDefaults: false });
}

/** True when a discovered skill file lives inside the packaged built-in directory —
 * the skills UI labels those rows "built-in" instead of "global". */
export function isBuiltinSkillPath(filePath: string): boolean {
	const directory = builtinSkillsDir();
	if (!directory) return false;
	const relativePath = relative(resolve(directory), resolve(filePath));
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

export function createLingSkillResources() {
	// Keep each loader's authoritative discovery available to Settings, including disabled
	// skills. Weak ownership releases closed projects and retired session generations.
	const discoveredSkills = new WeakMap<PiResourceLoader, PiResourceLoader["getSkills"]>();

	function readDiscoveredSkills(loader: PiResourceLoader): PiSkillsResult {
		const read = discoveredSkills.get(loader);
		if (!read) throw new Error("Ling skill switches are not installed on this resource loader");
		return read();
	}

	/**
	 * Prepare one resource generation's switches, then install them before creating its
	 * AgentSession. Pi applies source metadata AFTER skillsOverride, so filtering there
	 * mistakes project .agents, extra-path and package skills for temporary/global ones.
	 * Reading through getSkills preserves the SDK's final scope and live extendResources.
	 */
	async function createLingSkillToggles(
		settingsManager: PiSettingsManager,
		agentDir: string,
		cwd: string,
		inventory: Awaited<ReturnType<DefaultPackageManager["resolve"]>>["skills"],
	): Promise<(loader: PiResourceLoader) => void> {
		const inventoryDiagnostics: PiSkillsResult["diagnostics"] = [];
		const discovered = inventory
			.filter((resource) => resource.metadata.scope !== "project" || settingsManager.isProjectTrusted())
			.flatMap((resource) => {
				const loaded = loadSkills({ cwd, agentDir, skillPaths: [resource.path], includeDefaults: false });
				inventoryDiagnostics.push(...loaded.diagnostics);
				return loaded.skills.map((skill) => ({
					...skill,
					sourceInfo: { ...skill.sourceInfo, ...resource.metadata, path: skill.filePath },
				}));
			});
		const store = createPiGlobalSettingsStore(agentDir);
		let config = readLingSkillsConfig(settingsManager.getGlobalSettings() as Record<string, unknown>);
		if (config.legacyDisabled.length) {
			await store.transact((settings) => {
				const before = JSON.stringify(settings);
				const latest = readLingSkillsConfig(settings);
				const matches = discovered.filter(
					(skill) => skill.sourceInfo.scope !== "project" && latest.legacyDisabled.includes(skill.name),
				);
				const matched = new Set(matches.map((skill) => skill.name));
				const builtins = new Set(loadBuiltinSkills(agentDir).skills.map((skill) => skill.name));
				const paths = settings.skills === undefined ? [] : settings.skills;
				if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
					throw new Error("Pi settings skills must contain paths");
				if (matches.length) settings.skills = [...new Set([...paths, ...matches.map((skill) => `-${skill.filePath}`)])];
				config = {
					...latest,
					disabled: latest.disabled.filter((name) => builtins.has(name)),
					legacyDisabled: latest.legacyDisabled.filter((name) => !matched.has(name) && !builtins.has(name)),
				};
				writeLingSkillsConfig(settings, config);
				return { commit: JSON.stringify(settings) !== before, result: undefined };
			});
			await settingsManager.reload();
		}
		const disabled = new Set(config.disabled);
		const unresolved = new Set(config.legacyDisabled);
		const builtin = config.builtinEnabled ? loadBuiltinSkills(agentDir) : { skills: [], diagnostics: [] };

		return (loader) => {
			const read = loader.getSkills.bind(loader);
			discoveredSkills.set(loader, () => {
				const base = read();
				const unique = new Map([...discovered, ...base.skills].map((skill) => [skill.filePath, skill]));
				const diagnostics = new Map(
					[...base.diagnostics, ...inventoryDiagnostics].map((entry) => [`${entry.path}:${entry.message}`, entry]),
				);
				return { skills: [...unique.values()], diagnostics: [...diagnostics.values()] };
			});
			loader.getSkills = () => {
				const base = read();
				const kept = base.skills.filter((skill) => skill.sourceInfo.scope === "project" || !unresolved.has(skill.name));
				const shadowed = new Set(base.skills.map((skill) => skill.name));
				return {
					skills: [
						...kept,
						...builtin.skills.filter((skill) => !shadowed.has(skill.name) && !disabled.has(skill.name)),
					],
					diagnostics: [...base.diagnostics, ...builtin.diagnostics],
				};
			};
		};
	}
	return { readDiscoveredSkills, createLingSkillToggles };
}

export type LingSkillResources = ReturnType<typeof createLingSkillResources>;
