import { loadSkills } from "@earendil-works/pi-coding-agent";
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
	/** Names Ling unloads entirely — applies to every non-project-scoped skill
	 * (user, package, extra-path, built-in). A disabled skill is absent from the
	 * system prompt, not merely inert. */
	disabled: string[];
}

/** Parses the `lingSkills` settings key. Absent means all enabled; a malformed
 * value is a settings-file corruption and must surface, matching the `skills` array. */
export function readLingSkillsConfig(settings: Record<string, unknown>): LingSkillsConfig {
	const value = settings[LING_SKILLS_SETTINGS_KEY];
	if (value === undefined) return { builtinEnabled: true, disabled: [] };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Pi settings 'lingSkills' must be an object");
	}
	const record = value as { builtinEnabled?: unknown; disabled?: unknown };
	if (record.builtinEnabled !== undefined && typeof record.builtinEnabled !== "boolean") {
		throw new Error("Pi settings 'lingSkills.builtinEnabled' must be a boolean");
	}
	if (
		record.disabled !== undefined &&
		(!Array.isArray(record.disabled) || record.disabled.some((entry) => typeof entry !== "string"))
	) {
		throw new Error("Pi settings 'lingSkills.disabled' must be an array of skill names");
	}
	return { builtinEnabled: record.builtinEnabled ?? true, disabled: (record.disabled as string[] | undefined) ?? [] };
}

/** Writes the switches back, normalizing the shipped default (all enabled) to an
 * absent key so untouched installs keep a clean settings.json. */
export function writeLingSkillsConfig(settings: Record<string, unknown>, config: LingSkillsConfig): void {
	if (config.builtinEnabled && config.disabled.length === 0) delete settings[LING_SKILLS_SETTINGS_KEY];
	else settings[LING_SKILLS_SETTINGS_KEY] = { builtinEnabled: config.builtinEnabled, disabled: config.disabled };
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
	function createLingSkillToggles(
		settingsManager: PiSettingsManager,
		agentDir: string,
	): (loader: PiResourceLoader) => void {
		const config = readLingSkillsConfig(settingsManager.getGlobalSettings() as unknown as Record<string, unknown>);
		const disabled = new Set(config.disabled);
		const builtin = config.builtinEnabled ? loadBuiltinSkills(agentDir) : { skills: [], diagnostics: [] };
		return (loader) => {
			const read = loader.getSkills.bind(loader);
			discoveredSkills.set(loader, read);
			loader.getSkills = () => {
				const base = read();
				const kept = base.skills.filter((skill) => skill.sourceInfo.scope === "project" || !disabled.has(skill.name));
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
