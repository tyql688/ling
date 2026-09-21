import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGlobalSkillUpdateArgs, planGlobalSkillUpdates } from "./skill-update-runner";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One global skill as the skills CLI records it in its ledger. */
function lockEntry(source: string, overrides: Record<string, unknown> = {}) {
	return {
		source,
		sourceType: "github",
		sourceUrl: `https://github.com/${source}.git`,
		skillPath: "skills/better-ui/SKILL.md",
		skillFolderHash: "710b8e9a1b4086594d24050bbb6768dbc421e9dc",
		...overrides,
	};
}

/** An isolated state root: the CLI's global ledger plus Pi's skills directory. */
async function createState(skills: Record<string, unknown>) {
	const root = await temporaryDirectory("skill-update");
	roots.push(root);
	const stateDir = join(root, "state");
	await mkdir(join(stateDir, "skills"), { recursive: true });
	await writeFile(join(stateDir, "skills", ".skill-lock.json"), JSON.stringify({ version: 3, skills }));
	vi.stubEnv("XDG_STATE_HOME", stateDir);
	return { root, skillsDir: join(root, "pi", "skills") };
}

describe("global skill update planning", () => {
	it("copies into Pi's own directory for a skill Pi owns outright", async () => {
		const { skillsDir } = await createState({ "better-ui": lockEntry("jakubkrehel/skills") });
		await mkdir(join(skillsDir, "better-ui"), { recursive: true });

		const plans = await planGlobalSkillUpdates(["better-ui"], skillsDir);

		expect(plans).toEqual([{ name: "better-ui", source: "jakubkrehel/skills", shared: false }]);
		// A single target is a copy, so this refresh stays inside Pi's skills directory.
		expect(plans.map(buildGlobalSkillUpdateArgs)).toEqual([
			["add", "jakubkrehel/skills", "--skill", "better-ui", "-g", "-y", "--agent", "pi"],
		]);
	});

	it("rewrites the shared store for a skill Pi links into it, without naming another agent", async () => {
		const { root, skillsDir } = await createState({ "better-ui": lockEntry("jakubkrehel/skills") });
		await mkdir(join(root, "shared", "better-ui"), { recursive: true });
		await mkdir(skillsDir, { recursive: true });
		await symlink(join(root, "shared", "better-ui"), join(skillsDir, "better-ui"));

		const plans = await planGlobalSkillUpdates(["better-ui"], skillsDir);

		expect(plans).toEqual([{ name: "better-ui", source: "jakubkrehel/skills", shared: true }]);
		// `universal` is the CLI's own name for the store; naming it keeps the refresh out of
		// every agent directory while Pi's link keeps pointing at one shared copy.
		expect(plans.map(buildGlobalSkillUpdateArgs)).toEqual([
			["add", "jakubkrehel/skills", "--skill", "better-ui", "-g", "-y", "--agent", "pi", "universal"],
		]);
	});

	it("refuses a name the CLI ledger does not track", async () => {
		const { skillsDir } = await createState({});
		await expect(planGlobalSkillUpdates(["better-ui"], skillsDir)).rejects.toThrow(
			"The skills CLI does not track a global skill named better-ui",
		);
	});

	it("refuses a skill Pi does not load", async () => {
		const { skillsDir } = await createState({ "better-ui": lockEntry("jakubkrehel/skills") });
		await expect(planGlobalSkillUpdates(["better-ui"], skillsDir)).rejects.toThrow(
			"Global skill better-ui is not installed in Pi's skills directory",
		);
	});

	it("refuses a skill the CLI cannot reinstall from GitHub", async () => {
		const { skillsDir } = await createState({
			"better-ui": lockEntry("/tmp/better-ui", { sourceType: "local" }),
		});
		await mkdir(join(skillsDir, "better-ui"), { recursive: true });
		await expect(planGlobalSkillUpdates(["better-ui"], skillsDir)).rejects.toThrow(
			"Global skill better-ui was not installed from a GitHub repository",
		);
	});
});
