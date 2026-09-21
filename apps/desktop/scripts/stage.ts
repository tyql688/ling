import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Range, satisfies } from "semver";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const stageRoot = join(desktopRoot, ".stage");
const hostBuild = join(repositoryRoot, "packages/host/dist/index.js");
const webBuild = join(repositoryRoot, "apps/web/dist/index.html");
const appIcon = join(repositoryRoot, "resources/icon.png");

interface NodeRuntimeProbe {
	execPath: string;
	platform: NodeJS.Platform;
	arch: string;
	version: string;
}

function nodeEngineRange(): Range {
	const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
		engines?: { node?: unknown };
	};
	const range = packageJson.engines?.node;
	if (typeof range !== "string" || range.trim().length === 0) {
		throw new Error("Root package.json must declare engines.node");
	}
	return new Range(range);
}

function nodeRuntimeCandidates(executableName: string): string[] {
	const candidates = [
		process.execPath,
		...(process.env.PATH ?? "")
			.split(delimiter)
			.filter((directory) => directory.length > 0)
			.map((directory) => join(directory, executableName)),
	];
	return [
		...new Set(candidates.filter((candidate) => existsSync(candidate)).map((candidate) => realpathSync(candidate))),
	];
}

function nodeLicense(executable: string): string | undefined {
	return [join(dirname(executable), "LICENSE"), resolve(dirname(executable), "../LICENSE")].find((candidate) =>
		existsSync(candidate),
	);
}

function darwinNonSystemDependencies(executable: string): string[] {
	if (process.platform !== "darwin") return [];
	const inspection = spawnSync("/usr/bin/otool", ["-L", executable], {
		encoding: "utf8",
		stdio: "pipe",
		windowsHide: true,
	});
	if (inspection.error) throw inspection.error;
	if (inspection.status !== 0)
		throw new Error(`Could not inspect Node runtime ${executable}: ${inspection.stderr.trim()}`);
	return inspection.stdout
		.split("\n")
		.slice(1)
		.map((line) => /^\s+(.+?) \(compatibility version/.exec(line)?.[1])
		.filter((dependency): dependency is string => dependency !== undefined)
		.filter((dependency) => !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/"));
}

function stageNodeRuntime(runtimeStage: string): void {
	const executableName = process.platform === "win32" ? "node.exe" : "node";
	const stagedExecutable = join(runtimeStage, executableName);
	const failures: string[] = [];
	const engineRange = nodeEngineRange();
	for (const candidate of nodeRuntimeCandidates(executableName)) {
		const license = nodeLicense(candidate);
		if (!license) {
			failures.push(`${candidate}: Node license not found`);
			continue;
		}
		const externalDependencies = darwinNonSystemDependencies(candidate);
		if (externalDependencies.length > 0) {
			failures.push(`${candidate}: requires non-system libraries (${externalDependencies.join(", ")})`);
			continue;
		}
		cpSync(candidate, stagedExecutable);
		const probe = spawnSync(
			stagedExecutable,
			[
				"-p",
				"JSON.stringify({execPath:process.execPath,platform:process.platform,arch:process.arch,version:process.versions.node})",
			],
			{ encoding: "utf8", stdio: "pipe", windowsHide: true },
		);
		if (probe.error || probe.status !== 0) {
			failures.push(`${candidate}: copied runtime did not launch (${probe.error?.message ?? probe.stderr.trim()})`);
			continue;
		}
		const result = JSON.parse(probe.stdout) as NodeRuntimeProbe;
		if (realpathSync(result.execPath) !== realpathSync(stagedExecutable)) {
			failures.push(`${candidate}: delegates to another Node executable (${result.execPath})`);
			continue;
		}
		if (result.platform !== process.platform || result.arch !== process.arch) {
			failures.push(
				`${candidate}: runtime target is ${result.platform}/${result.arch}, expected ${process.platform}/${process.arch}`,
			);
			continue;
		}
		if (!satisfies(result.version, engineRange)) {
			failures.push(`${candidate}: Node ${result.version} does not satisfy ${engineRange.raw}`);
			continue;
		}
		cpSync(license, join(runtimeStage, "LICENSE.node.txt"));
		console.log(`Staged standalone Node ${result.version} from ${candidate}`);
		return;
	}
	rmSync(runtimeStage, { recursive: true, force: true });
	throw new Error(
		`Could not stage a standalone Node Host runtime. Install an official Node distribution and expose it on PATH.\n${failures.join("\n")}`,
	);
}

for (const required of [hostBuild, webBuild, appIcon]) {
	if (!existsSync(required)) throw new Error(`Required Ling build output is missing: ${required}`);
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

cpSync(join(repositoryRoot, "apps/web/dist"), join(stageRoot, "web"), { recursive: true });
cpSync(join(repositoryRoot, "builtin-skills"), join(stageRoot, "builtin-skills"), { recursive: true });
cpSync(appIcon, join(stageRoot, "icon.png"));

const runtimeStage = join(stageRoot, "runtime");
mkdirSync(runtimeStage, { recursive: true });
stageNodeRuntime(runtimeStage);
