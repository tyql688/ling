import type { TerminalProfile, TerminalProfileSource, TerminalProfilesSnapshot } from "@ling/contracts/terminal";
import { resolveCommand } from "@ling/core/command-resolver";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

type DetectedTerminalProfiles = Omit<TerminalProfilesSnapshot, "configuredProfileId">;

interface ProfileCandidate {
	path: string;
	name: string;
	args: string[];
	source: TerminalProfileSource;
}

/** Basename allowlist of what counts as an "interactive shell"; only these names enter the profile list, so arbitrary PATH executables are not mistaken for shells. */
const POSIX_SHELL_NAMES = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "pwsh"]);

function profileId(path: string, args: readonly string[]): string {
	const identity = JSON.stringify([path, ...args]);
	return `shell:${createHash("sha256").update(identity, "utf8").digest("base64url")}`;
}

function displayName(path: string): string {
	const executable = basename(path)
		.replace(/\.exe$/iu, "")
		.toLowerCase();
	if (executable === "zsh") return "Zsh";
	if (executable === "bash") return "Bash";
	if (executable === "fish") return "Fish";
	if (executable === "nu") return "Nushell";
	if (executable === "pwsh") return "PowerShell";
	if (executable === "powershell") return "Windows PowerShell";
	if (executable === "cmd") return "Command Prompt";
	if (executable === "sh") return "POSIX Shell";
	if (executable === "dash") return "Dash";
	if (executable === "ksh") return "KornShell";
	if (executable === "tcsh") return "Tcsh";
	if (executable === "csh") return "C Shell";
	return basename(path);
}

function loginArgs(path: string, platform: NodeJS.Platform): string[] {
	const executable = basename(path)
		.replace(/\.exe$/iu, "")
		.toLowerCase();
	if (platform === "win32") {
		if (executable === "pwsh" || executable === "powershell") return ["-NoLogo"];
		if (executable === "bash") return ["--login", "-i"];
		return [];
	}
	if (executable === "pwsh") return ["-NoLogo", "-Login"];
	if (executable === "nu") return ["--login"];
	if (executable === "zsh" || executable === "bash" || executable === "fish" || executable === "ksh") return ["-l"];
	return [];
}

async function executable(path: string): Promise<boolean> {
	if (!isAbsolute(path)) return false;
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function posixShellFileCandidates(): Promise<string[]> {
	try {
		const contents = await readFile("/etc/shells", "utf8");
		return contents
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line.startsWith("/") && POSIX_SHELL_NAMES.has(basename(line).toLowerCase()));
	} catch {
		return [];
	}
}

function resolvedCommandCandidates(commands: readonly string[], platform: NodeJS.Platform): ProfileCandidate[] {
	const candidates: ProfileCandidate[] = [];
	for (const command of commands) {
		const path = resolveCommand(command);
		if (!path) continue;
		candidates.push({
			path,
			name: displayName(path),
			args: loginArgs(path, platform),
			source: "path",
		});
	}
	return candidates;
}

function windowsFallbackPaths(environment: NodeJS.ProcessEnv): string[] {
	const candidates: string[] = [];
	const programFiles = environment.ProgramFiles;
	if (programFiles) {
		candidates.push(join(programFiles, "PowerShell", "7", "pwsh.exe"));
		candidates.push(join(programFiles, "Git", "bin", "bash.exe"));
	}
	const systemRoot = environment.SystemRoot;
	if (systemRoot) {
		candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
		candidates.push(join(systemRoot, "System32", "cmd.exe"));
	}
	return candidates;
}

async function candidatePaths(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): Promise<ProfileCandidate[]> {
	const candidates: ProfileCandidate[] = [];
	const environmentShell = environment.SHELL;
	if (environmentShell && isAbsolute(environmentShell)) {
		candidates.push({
			path: environmentShell,
			name: displayName(environmentShell),
			args: loginArgs(environmentShell, platform),
			source: "environment",
		});
	}

	const pathCommands =
		platform === "win32"
			? ["pwsh.exe", "pwsh", "powershell.exe", "powershell", "cmd.exe", "bash.exe"]
			: ["zsh", "bash", "fish", "nu", "pwsh", "sh"];
	candidates.push(...resolvedCommandCandidates(pathCommands, platform));
	const systemPaths =
		platform === "win32"
			? [
					...(environment.ComSpec && isAbsolute(environment.ComSpec) ? [environment.ComSpec] : []),
					...windowsFallbackPaths(environment),
				]
			: await posixShellFileCandidates();
	for (const path of systemPaths) {
		candidates.push({
			path,
			name: displayName(path),
			args: loginArgs(path, platform),
			source: path === environmentShell ? "environment" : "system",
		});
	}
	return candidates;
}

function profilePreference(profile: TerminalProfile, platform: NodeJS.Platform): number {
	if (profile.source === "environment") return 0;
	const name = basename(profile.path).toLowerCase();
	const order =
		platform === "win32"
			? ["pwsh.exe", "powershell.exe", "cmd.exe", "bash.exe"]
			: platform === "darwin"
				? ["zsh", "bash", "fish", "nu", "sh"]
				: ["bash", "zsh", "fish", "nu", "sh"];
	const index = order.indexOf(name);
	return index < 0 ? order.length + 1 : index + 1;
}

export async function detectTerminalProfiles(): Promise<DetectedTerminalProfiles> {
	const platform = process.platform;
	const environment = process.env;
	const profiles: TerminalProfile[] = [];
	const seen = new Set<string>();
	const candidates = await candidatePaths(platform, environment);
	const availability = await Promise.all(candidates.map((candidate) => executable(candidate.path)));
	for (const [index, candidate] of candidates.entries()) {
		if (!availability[index]) continue;
		const path = candidate.path;
		const id = profileId(path, candidate.args);
		if (seen.has(id)) continue;
		seen.add(id);
		profiles.push({
			id,
			name: candidate.name,
			path,
			args: [...candidate.args],
			source: candidate.source,
		});
	}
	profiles.sort((left, right) => {
		const preference = profilePreference(left, platform) - profilePreference(right, platform);
		return preference === 0 ? left.name.localeCompare(right.name) : preference;
	});
	const suggested = profiles[0];
	if (!suggested) throw new Error("Ling could not find an executable shell for the integrated terminal.");
	return { profiles, suggestedProfileId: suggested.id };
}

export async function resolveTerminalProfile(profileId: string | null): Promise<TerminalProfile> {
	const snapshot = await detectTerminalProfiles();
	const resolvedId = profileId ?? snapshot.suggestedProfileId;
	const profile = snapshot.profiles.find((candidate) => candidate.id === resolvedId);
	if (!profile) {
		throw new Error("The configured terminal profile is no longer available. Choose another profile in Settings.");
	}
	return profile;
}
