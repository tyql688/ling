import { toError } from "@ling/core/ling-error";
import { readGlobalSkillUpdateEntries } from "@ling/core/skills/skill-lock";
import { terminateProcessTree } from "@ling/node-runtime/process-tree-terminator";
import { createToolchainChildEnvironment } from "@ling/host/runtime/host-child-environment";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** Five minutes bounds one update batch, including every download and installation it performs. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** Retain at most 200k characters of the batch's installer output for the result or visible error. */
const UPDATE_OUTPUT_MAX_CHARS = 200_000;
/**
 * The CLI's id for the shared `.agents/skills` store. Naming it beside Pi makes the CLI rewrite
 * that store and keep Pi's link to it; with a single target the CLI copies into that agent's own
 * directory instead, which would leave a private copy whose name shadows the shared one. An
 * unknown id fails the command, so a renamed store surfaces as an error rather than silently
 * degrading into a per-agent copy.
 */
const SHARED_STORE_AGENT = "universal";

let updateRunning = false;

const requireFromHost = createRequire(import.meta.url);

function resolveNpxCli(): string {
	const manifestPath = requireFromHost.resolve("npm/package.json");
	const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		throw new Error("The installed npm package has an invalid manifest");
	}
	const bin = (manifest as { bin?: unknown }).bin;
	const npx = typeof bin === "object" && bin !== null && !Array.isArray(bin) ? (bin as { npx?: unknown }).npx : null;
	if (typeof npx !== "string" || npx.length === 0) throw new Error("The installed npm package does not expose npx");
	const packageRoot = dirname(manifestPath);
	const cliPath = resolve(packageRoot, npx);
	const childPath = relative(packageRoot, cliPath);
	if (childPath === "" || isAbsolute(childPath) || childPath === ".." || childPath.startsWith(`..${sep}`)) {
		throw new Error("The installed npm package exposes npx outside its package root");
	}
	return cliPath;
}

/** What one requested skill needs before the CLI can refresh it. */
interface GlobalSkillUpdatePlan {
	/** Skill name, as both the CLI's ledger and Pi know it. */
	name: string;
	/** Repository shorthand from the ledger, e.g. `owner/repo`. */
	source: string;
	/** Pi's entry is a symlink into the shared store, so the refresh must rewrite that store. */
	shared: boolean;
}

/**
 * Resolves every requested name against the CLI's ledger and Pi's skills directory. The renderer
 * supplies the names, so each one must be a global skill the CLI tracks from GitHub whose files Pi
 * actually loads; anything else fails instead of guessing an install target.
 */
export async function planGlobalSkillUpdates(names: string[], skillsDir: string): Promise<GlobalSkillUpdatePlan[]> {
	const { entries } = readGlobalSkillUpdateEntries();
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const plans: GlobalSkillUpdatePlan[] = [];
	for (const name of names) {
		const entry = byName.get(name);
		if (entry === undefined) throw new Error(`The skills CLI does not track a global skill named ${name}`);
		if (entry.sourceType !== "github" || entry.source.length === 0) {
			throw new Error(`Global skill ${name} was not installed from a GitHub repository`);
		}
		const info = await lstat(join(skillsDir, name)).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw toError(error);
		});
		if (info === null) throw new Error(`Global skill ${name} is not installed in Pi's skills directory`);
		plans.push({ name, source: entry.source, shared: info.isSymbolicLink() });
	}
	return plans;
}

/**
 * The CLI arguments for one refresh. Pi is the only agent Ling may write to; a shared skill names
 * the store it is linked into as well, so the CLI keeps rewriting one shared copy. Naming a second
 * agent here would reach into that agent's directory — the fan-out `skills update` performs.
 */
export function buildGlobalSkillUpdateArgs(plan: GlobalSkillUpdatePlan): string[] {
	const args = ["add", plan.source, "--skill", plan.name, "-g", "-y", "--agent", "pi"];
	if (plan.shared) args.push(SHARED_STORE_AGENT);
	return args;
}

function capOutput(text: string): string {
	return text.length > UPDATE_OUTPUT_MAX_CHARS ? text.slice(0, UPDATE_OUTPUT_MAX_CHARS) : text;
}

interface SkillUpdateOutcome {
	code: number;
	text: string;
}

/**
 * Runs one refresh to completion. The CLI itself performs the work so its install pipeline (clone,
 * discovery, ledger rewrite) stays authoritative. `-y` plus a non-TTY stdin keeps it prompt-free,
 * which is also how the CLI skips its deletion prompts in non-interactive mode.
 */
function runSkillUpdate(cli: string, plan: GlobalSkillUpdatePlan, timeoutMs: number): Promise<SkillUpdateOutcome> {
	return new Promise<SkillUpdateOutcome>((resolve, reject) => {
		const child = spawn(process.execPath, [cli, "-y", "skills", ...buildGlobalSkillUpdateArgs(plan)], {
			stdio: ["ignore", "pipe", "pipe"],
			env: createToolchainChildEnvironment(),
			windowsHide: true,
		});
		let output = "";
		let settled = false;
		let timedOut = false;
		const capture = (chunk: Buffer): void => {
			if (output.length < UPDATE_OUTPUT_MAX_CHARS) {
				output += chunk.toString().slice(0, UPDATE_OUTPUT_MAX_CHARS - output.length);
			}
		};
		const settle = (run: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			run();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			const pid = child.pid;
			if (pid === undefined) {
				settle(() => reject(new Error(`skills add exceeded ${timeoutMs} ms before spawning`)));
				return;
			}
			void terminateProcessTree({
				pid,
				terminateRoot: () => child.kill(),
				rootExited: () => child.exitCode !== null || child.signalCode !== null,
			}).catch((error: unknown) => {
				settle(() =>
					reject(
						new AggregateError(
							[new Error(`skills add exceeded ${timeoutMs} ms`), toError(error)],
							"Skills update timed out and its process tree could not be terminated",
						),
					),
				);
			});
		}, timeoutMs);
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.once("error", (error) => {
			settle(() => reject(error));
		});
		child.once("close", (code) => {
			settle(() => {
				const text = stripVTControlCharacters(output).replace(/\r(?!\n)/g, "\n");
				if (timedOut) reject(new Error(`skills add exceeded ${timeoutMs} ms:\n${text}`));
				else resolve({ code: code ?? 0, text });
			});
		});
	});
}

/**
 * Refreshes the named global skills through the CLI without writing to another agent's directory.
 * The CLI cannot scope its own `update` to one agent, so each plan is installed by name with Pi
 * named explicitly. Every plan is attempted; a failure reports the failing skills and the batch's
 * output, leaving the skills that did update in place.
 */
export async function runGlobalSkillsUpdate(plans: GlobalSkillUpdatePlan[]): Promise<string> {
	if (updateRunning) throw new Error("A skills update is already running.");
	updateRunning = true;
	try {
		const cli = resolveNpxCli();
		const startedAt = Date.now();
		const blocks: string[] = [];
		const failures: string[] = [];
		for (const plan of plans) {
			const remaining = UPDATE_TIMEOUT_MS - (Date.now() - startedAt);
			if (remaining <= 0) {
				failures.push(`${plan.name}: the update batch ran out of time before it started`);
				break;
			}
			const outcome = await runSkillUpdate(cli, plan, remaining);
			const text = outcome.text.trim();
			blocks.push(plans.length > 1 ? `${plan.name}\n${text}` : text);
			if (outcome.code !== 0) failures.push(`${plan.name}: the skills CLI exited with code ${String(outcome.code)}`);
		}
		const output = capOutput(blocks.join("\n"));
		if (failures.length > 0) {
			throw new Error(
				`Skills update failed for ${failures.length} of ${plans.length} skill(s):\n` +
					`${failures.map((line) => `  ${line}`).join("\n")}\n\n${output}`,
			);
		}
		return output;
	} finally {
		updateRunning = false;
	}
}
