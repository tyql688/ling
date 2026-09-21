import {
	PROJECT_LAUNCH_TARGET_KIND_BY_ID,
	type ProjectLaunchTarget,
	type ProjectLaunchTargetId,
	type ProjectLaunchTargetKind,
} from "@ling/contracts/project";
import { resolveCommand } from "@ling/core/command-resolver";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";

/** `open -Ra` and `open -a` should return immediately; bound a broken launch service. */
const PROJECT_LAUNCH_COMMAND_TIMEOUT_MS = 10_000;

type ResolveExecutable = (command: string) => string | undefined;
type ProbeMacApplication = (name: string) => Promise<boolean>;
type RunCommand = (command: string, args: readonly string[], cwd?: string) => Promise<void>;
type LaunchDetached = (command: string, args: readonly string[], cwd: string) => Promise<void>;

interface ProjectLauncher {
	listTargets(): Promise<ProjectLaunchTarget[]>;
	launch(cwd: string, targetId: ProjectLaunchTargetId): Promise<void>;
	launchDefault(cwd: string, kind: ProjectLaunchTargetKind, preferredId: ProjectLaunchTargetId | null): Promise<void>;
}

interface LaunchCandidate {
	target: ProjectLaunchTarget;
	available: () => Promise<boolean>;
	launch: (cwd: string) => Promise<void>;
}

interface LauncherDependencies {
	openPath: (path: string) => Promise<void>;
	platform: NodeJS.Platform;
	environment: NodeJS.ProcessEnv;
	resolveExecutable: ResolveExecutable;
	probeMacApplication: ProbeMacApplication;
	runCommand: RunCommand;
	launchDetached: LaunchDetached;
}

function target(id: ProjectLaunchTargetId, kind: ProjectLaunchTargetKind, name: string): ProjectLaunchTarget {
	return { id, kind, name };
}

function fileManagerName(platform: NodeJS.Platform): string {
	if (platform === "darwin") return "Finder";
	if (platform === "win32") return "File Explorer";
	return "System File Manager";
}

function systemFileManagerCandidate(dependencies: LauncherDependencies): LaunchCandidate {
	return {
		target: target("file-manager", "file-manager", fileManagerName(dependencies.platform)),
		available: async () => true,
		launch: dependencies.openPath,
	};
}

function resolveFirst(commands: readonly string[], dependencies: LauncherDependencies): string | undefined {
	for (const command of commands) {
		const executable = dependencies.resolveExecutable(command);
		if (executable) return executable;
	}
	return undefined;
}

function commandCandidate(
	definition: ProjectLaunchTarget,
	commands: readonly string[],
	args: (cwd: string) => readonly string[],
	dependencies: LauncherDependencies,
): LaunchCandidate {
	return {
		target: definition,
		available: async () => resolveFirst(commands, dependencies) !== undefined,
		launch: async (cwd) => {
			const executable = resolveFirst(commands, dependencies);
			if (!executable) throw new Error(`${definition.name} is no longer available.`);
			await dependencies.launchDetached(executable, args(cwd), cwd);
		},
	};
}

/** Resolve both the registered macOS application and its optional CLI. Editors and
 * application-only terminals prefer the bundle identity so a shadowed command name
 * cannot open the wrong product; CLI-capable terminals retain precise cwd arguments. */
function macApplicationCandidate(
	definition: ProjectLaunchTarget,
	applicationName: string,
	commands: readonly string[],
	args: (cwd: string) => readonly string[],
	dependencies: LauncherDependencies,
	launchPreference: "application" | "command" = "command",
): LaunchCandidate {
	return {
		target: definition,
		available: async () =>
			resolveFirst(commands, dependencies) !== undefined || dependencies.probeMacApplication(applicationName),
		launch: async (cwd) => {
			if (launchPreference === "application" && (await dependencies.probeMacApplication(applicationName))) {
				await dependencies.runCommand("open", ["-a", applicationName, cwd]);
				return;
			}
			const executable = resolveFirst(commands, dependencies);
			if (executable) {
				await dependencies.launchDetached(executable, args(cwd), cwd);
				return;
			}
			if (!(await dependencies.probeMacApplication(applicationName))) {
				throw new Error(`${definition.name} is no longer available.`);
			}
			await dependencies.runCommand("open", ["-a", applicationName, cwd]);
		},
	};
}

function windowsSystemTerminalCandidate(dependencies: LauncherDependencies): LaunchCandidate {
	// Windows Terminal's app-execution alias lives outside many machines' PATH even when installed.
	const windowsTerminalCommands = [
		"wt.exe",
		"wt",
		...windowsInstallHints(dependencies, [join("Microsoft", "WindowsApps", "wt.exe")]),
	];
	return {
		target: target("system-terminal", "terminal", "Windows Terminal"),
		available: async () =>
			resolveFirst(windowsTerminalCommands, dependencies) !== undefined ||
			resolveFirst(["cmd.exe"], dependencies) !== undefined,
		launch: async (cwd) => {
			const windowsTerminal = resolveFirst(windowsTerminalCommands, dependencies);
			if (windowsTerminal) {
				await dependencies.launchDetached(windowsTerminal, ["-d", cwd], cwd);
				return;
			}
			const commandPrompt = resolveFirst(["cmd.exe"], dependencies);
			if (!commandPrompt) throw new Error("No supported system terminal is available.");
			// A GUI parent owns no console, so a detached cmd.exe would run invisibly; `start`
			// always allocates a fresh visible console. Empty "" title survives node's arg quoting.
			await dependencies.launchDetached(commandPrompt, ["/d", "/c", "start", "", "/d", cwd, "cmd.exe"], cwd);
		},
	};
}

function windowsInstallHints(dependencies: LauncherDependencies, relativePaths: readonly string[]): string[] {
	const roots = [
		dependencies.environment.LOCALAPPDATA,
		dependencies.environment.ProgramFiles,
		dependencies.environment["ProgramFiles(x86)"],
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	return roots.flatMap((root) => relativePaths.map((relativePath) => join(root, relativePath)));
}

function macCandidates(dependencies: LauncherDependencies): LaunchCandidate[] {
	return [
		systemFileManagerCandidate(dependencies),
		macApplicationCandidate(
			target("visual-studio-code", "editor", "Visual Studio Code"),
			"Visual Studio Code",
			["code"],
			(cwd) => ["--reuse-window", cwd],
			dependencies,
			"application",
		),
		macApplicationCandidate(
			target("cursor", "editor", "Cursor"),
			"Cursor",
			["cursor"],
			(cwd) => ["--reuse-window", cwd],
			dependencies,
			"application",
		),
		macApplicationCandidate(
			target("zed", "editor", "Zed"),
			"Zed",
			["zed"],
			(cwd) => [cwd],
			dependencies,
			"application",
		),
		macApplicationCandidate(
			target("sublime-text", "editor", "Sublime Text"),
			"Sublime Text",
			["subl"],
			(cwd) => [cwd],
			dependencies,
			"application",
		),
		macApplicationCandidate(
			target("intellij-idea", "editor", "IntelliJ IDEA"),
			"IntelliJ IDEA",
			["idea"],
			(cwd) => [cwd],
			dependencies,
			"application",
		),
		macApplicationCandidate(
			target("goland", "editor", "GoLand"),
			"GoLand",
			["goland"],
			(cwd) => [cwd],
			dependencies,
			"application",
		),
		macApplicationCandidate(
			target("webstorm", "editor", "WebStorm"),
			"WebStorm",
			["webstorm"],
			(cwd) => [cwd],
			dependencies,
			"application",
		),
		macApplicationCandidate(target("system-terminal", "terminal", "Terminal"), "Terminal", [], () => [], dependencies),
		macApplicationCandidate(
			target("ghostty", "terminal", "Ghostty"),
			"Ghostty",
			["ghostty"],
			(cwd) => [`--working-directory=${cwd}`],
			dependencies,
		),
		macApplicationCandidate(target("iterm2", "terminal", "iTerm2"), "iTerm", [], () => [], dependencies),
		macApplicationCandidate(target("warp", "terminal", "Warp"), "Warp", [], () => [], dependencies),
		macApplicationCandidate(
			target("wezterm", "terminal", "WezTerm"),
			"WezTerm",
			["wezterm"],
			(cwd) => ["start", "--cwd", cwd],
			dependencies,
		),
		macApplicationCandidate(
			target("kitty", "terminal", "kitty"),
			"kitty",
			["kitty"],
			(cwd) => ["--directory", cwd],
			dependencies,
		),
		macApplicationCandidate(
			target("alacritty", "terminal", "Alacritty"),
			"Alacritty",
			["alacritty"],
			(cwd) => ["--working-directory", cwd],
			dependencies,
		),
	];
}

function commandEditorCandidates(dependencies: LauncherDependencies): LaunchCandidate[] {
	const windows = dependencies.platform === "win32";
	return [
		commandCandidate(
			target("visual-studio-code", "editor", "Visual Studio Code"),
			windows
				? [
						"code.exe",
						...windowsInstallHints(dependencies, [
							join("Programs", "Microsoft VS Code", "Code.exe"),
							join("Microsoft VS Code", "Code.exe"),
						]),
					]
				: ["code"],
			(cwd) => ["--reuse-window", cwd],
			dependencies,
		),
		commandCandidate(
			target("cursor", "editor", "Cursor"),
			windows
				? [
						"cursor.exe",
						...windowsInstallHints(dependencies, [
							join("Programs", "cursor", "Cursor.exe"),
							join("Programs", "Cursor", "Cursor.exe"),
							join("Cursor", "Cursor.exe"),
						]),
					]
				: ["cursor"],
			(cwd) => ["--reuse-window", cwd],
			dependencies,
		),
		commandCandidate(
			target("zed", "editor", "Zed"),
			windows ? ["zed.exe", ...windowsInstallHints(dependencies, [join("Programs", "Zed", "Zed.exe")])] : ["zed"],
			(cwd) => [cwd],
			dependencies,
		),
		commandCandidate(
			target("sublime-text", "editor", "Sublime Text"),
			windows
				? [
						"subl.exe",
						"sublime_text.exe",
						...windowsInstallHints(dependencies, [join("Sublime Text", "sublime_text.exe")]),
					]
				: ["subl", "sublime_text"],
			(cwd) => [cwd],
			dependencies,
		),
		commandCandidate(
			target("intellij-idea", "editor", "IntelliJ IDEA"),
			windows ? ["idea64.exe", "idea.exe", "idea"] : ["idea"],
			(cwd) => [cwd],
			dependencies,
		),
		commandCandidate(
			target("goland", "editor", "GoLand"),
			windows ? ["goland64.exe", "goland.exe", "goland"] : ["goland"],
			(cwd) => [cwd],
			dependencies,
		),
		commandCandidate(
			target("webstorm", "editor", "WebStorm"),
			windows ? ["webstorm64.exe", "webstorm.exe", "webstorm"] : ["webstorm"],
			(cwd) => [cwd],
			dependencies,
		),
	];
}

function portableTerminalCandidates(dependencies: LauncherDependencies): LaunchCandidate[] {
	return [
		commandCandidate(
			target("ghostty", "terminal", "Ghostty"),
			["ghostty"],
			(cwd) => [`--working-directory=${cwd}`],
			dependencies,
		),
		commandCandidate(
			target("wezterm", "terminal", "WezTerm"),
			["wezterm", "wezterm.exe"],
			(cwd) => ["start", "--cwd", cwd],
			dependencies,
		),
		commandCandidate(
			target("kitty", "terminal", "kitty"),
			["kitty", "kitty.exe"],
			(cwd) => ["--directory", cwd],
			dependencies,
		),
		commandCandidate(
			target("alacritty", "terminal", "Alacritty"),
			["alacritty", "alacritty.exe"],
			(cwd) => ["--working-directory", cwd],
			dependencies,
		),
	];
}

function linuxSystemTerminalCandidate(dependencies: LauncherDependencies): LaunchCandidate {
	const commands = [
		"gnome-terminal",
		"konsole",
		"xfce4-terminal",
		"mate-terminal",
		"tilix",
		"x-terminal-emulator",
		"xterm",
	];
	return {
		target: target("system-terminal", "terminal", "System Terminal"),
		available: async () => resolveFirst(commands, dependencies) !== undefined,
		launch: async (cwd) => {
			const executable = resolveFirst(commands, dependencies);
			if (!executable) throw new Error("No supported system terminal is available.");
			const name = basename(executable).toLowerCase();
			const args =
				name === "gnome-terminal" || name === "mate-terminal" || name === "tilix"
					? [`--working-directory=${cwd}`]
					: name === "konsole"
						? ["--workdir", cwd]
						: name === "xfce4-terminal"
							? [`--working-directory=${cwd}`]
							: [];
			await dependencies.launchDetached(executable, args, cwd);
		},
	};
}

function linuxCandidates(dependencies: LauncherDependencies): LaunchCandidate[] {
	return [
		systemFileManagerCandidate(dependencies),
		commandCandidate(
			target("nautilus", "file-manager", "Files (Nautilus)"),
			["nautilus"],
			(cwd) => [cwd],
			dependencies,
		),
		commandCandidate(target("dolphin", "file-manager", "Dolphin"), ["dolphin"], (cwd) => [cwd], dependencies),
		commandCandidate(target("thunar", "file-manager", "Thunar"), ["thunar"], (cwd) => [cwd], dependencies),
		commandCandidate(target("nemo", "file-manager", "Nemo"), ["nemo"], (cwd) => [cwd], dependencies),
		...commandEditorCandidates(dependencies),
		linuxSystemTerminalCandidate(dependencies),
		...portableTerminalCandidates(dependencies),
	];
}

function windowsCandidates(dependencies: LauncherDependencies): LaunchCandidate[] {
	return [
		systemFileManagerCandidate(dependencies),
		...commandEditorCandidates(dependencies),
		windowsSystemTerminalCandidate(dependencies),
		...portableTerminalCandidates(dependencies),
	];
}

function candidatesForPlatform(dependencies: LauncherDependencies): LaunchCandidate[] {
	if (dependencies.platform === "darwin") return macCandidates(dependencies);
	if (dependencies.platform === "win32") return windowsCandidates(dependencies);
	if (dependencies.platform === "linux") return linuxCandidates(dependencies);
	return [systemFileManagerCandidate(dependencies)];
}

function runForExitCode(command: string, args: readonly string[], cwd?: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			...(cwd === undefined ? {} : { cwd }),
		});
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`${command} did not exit within ${PROJECT_LAUNCH_COMMAND_TIMEOUT_MS} ms.`));
		}, PROJECT_LAUNCH_COMMAND_TIMEOUT_MS);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== null) {
				resolve(code);
				return;
			}
			reject(new Error(`${command} terminated before completing${signal ? ` (${signal})` : ""}.`));
		});
	});
}

async function defaultProbeMacApplication(name: string): Promise<boolean> {
	return (await runForExitCode("open", ["-Ra", name])) === 0;
}

async function defaultRunCommand(command: string, args: readonly string[], cwd?: string): Promise<void> {
	const code = await runForExitCode(command, args, cwd);
	if (code !== 0) throw new Error(`${command} exited with code ${code}.`);
}

function defaultLaunchDetached(command: string, args: readonly string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "ignore", detached: true, windowsHide: false });
		const onError = (error: Error): void => reject(error);
		child.once("error", onError);
		child.once("spawn", () => {
			child.removeListener("error", onError);
			child.unref();
			resolve();
		});
	});
}

/** Creates a launcher with short-lived discovery caching; actual launches always revalidate their chosen target. */
export function createProjectLauncher(): ProjectLauncher {
	const dependencies: LauncherDependencies = {
		openPath: (path) => {
			const command =
				process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
			return defaultLaunchDetached(command, [path], path);
		},
		platform: process.platform,
		environment: process.env,
		resolveExecutable: resolveCommand,
		probeMacApplication: defaultProbeMacApplication,
		runCommand: defaultRunCommand,
		launchDetached: defaultLaunchDetached,
	};
	const candidates = candidatesForPlatform(dependencies);
	let inventory: { expiresAt: number; value: Promise<LaunchCandidate[]> } | null = null;
	const availableCandidates = (): Promise<LaunchCandidate[]> => {
		const now = Date.now();
		if (inventory && inventory.expiresAt > now) return inventory.value;
		const value = Promise.all(candidates.map((candidate) => candidate.available())).then((availability) =>
			candidates.filter((_candidate, index) => availability[index]),
		);
		inventory = { expiresAt: now + 10_000, value };
		void value.catch(() => {
			if (inventory?.value === value) inventory = null;
		});
		return value;
	};

	return {
		listTargets: async () => (await availableCandidates()).map((candidate) => candidate.target),
		launch: async (cwd, targetId) => {
			const candidate = candidates.find((entry) => entry.target.id === targetId);
			if (!candidate || !(await candidate.available())) throw new Error("That project launcher is not available.");
			await candidate.launch(cwd);
		},
		launchDefault: async (cwd, kind, preferredId) => {
			if (preferredId !== null && PROJECT_LAUNCH_TARGET_KIND_BY_ID[preferredId] !== kind) {
				throw new Error("The configured project launcher does not match the requested action.");
			}
			const kindCandidates = candidates.filter((candidate) => candidate.target.kind === kind);
			let candidate: LaunchCandidate | undefined;
			if (preferredId === null) {
				for (const entry of kindCandidates) {
					if (await entry.available()) {
						candidate = entry;
						break;
					}
				}
			} else {
				const preferred = kindCandidates.find((entry) => entry.target.id === preferredId);
				if (preferred && (await preferred.available())) candidate = preferred;
			}
			if (!candidate) {
				throw new Error(
					preferredId === null
						? `No ${kind} launcher is available.`
						: "The configured project launcher is no longer available. Choose another one in Settings.",
				);
			}
			await candidate.launch(cwd);
		},
	};
}
