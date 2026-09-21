import { GIT_CWD_MAX_CHARS } from "@ling/contracts/git";
import { requireCommand } from "@ling/core/command-resolver";
import { assertProjectDirectory } from "@ling/host/runtime/project-directory";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import simpleGit from "simple-git";
import { assertGitPath } from "./git-output-parsers";

const UNSAFE_GIT_ENVIRONMENT_KEYS = new Set(["EDITOR", "PAGER", "PREFIX", "SSH_ASKPASS"]);
/** Default protection for every simple-git command, including write commands whose hooks
 * can print arbitrary output. Read paths that need a smaller/shared budget install their
 * own output handler and abort controller. */
const GIT_COMMAND_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** Kill a command that makes no stdout/stderr progress for two minutes. */
const GIT_COMMAND_STALL_TIMEOUT_MS = 120_000;

function gitEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		const normalizedKey = key.toUpperCase();
		// simple-git rejects these because Git can use them to execute user-selected
		// programs or load alternate configuration. Do not opt out of that protection.
		if (normalizedKey.startsWith("GIT") || UNSAFE_GIT_ENVIRONMENT_KEYS.has(normalizedKey)) continue;
		environment[key] = value;
	}
	environment.LANG = "C";
	environment.LC_ALL = "C";
	environment.LC_MESSAGES = "C";
	return environment;
}

export function assertAbsoluteGitPath(
	path: unknown,
	label: string,
	maxChars = GIT_CWD_MAX_CHARS,
): asserts path is string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.length > maxChars ||
		path.includes("\0") ||
		!isAbsolute(path)
	) {
		throw new Error(`Invalid ${label}`);
	}
}

/** Creates one isolated simple-git client per operation. `requireCommand` is only a
 * presence check: passing its resolved binary to simple-git breaks Windows paths that
 * contain spaces, so simple-git must continue spawning plain `git` through PATH.
 *
 * Force C locale: `checkIsRepo` (and other simple-git helpers) match English/German
 * "not a git repository" stderr only. Under zh_CN that becomes a thrown GitError, so a
 * legitimate non-repo project fails `project:list` instead of returning `isRepository: false`. */
export function createGitClient(cwd: string, abort?: AbortSignal) {
	assertAbsoluteGitPath(cwd, "git working directory");
	// simple-git reports a deleted base directory as its own internal error; a project whose folder
	// is gone must reach the renderer as a missing directory instead.
	assertProjectDirectory(cwd);
	requireCommand("git");
	const outputController = new AbortController();
	const operationSignal = abort ? AbortSignal.any([abort, outputController.signal]) : outputController.signal;
	const repo = simpleGit({
		baseDir: cwd,
		abort: operationSignal,
		timeout: { block: GIT_COMMAND_STALL_TIMEOUT_MS },
	}).env(gitEnvironment());
	repo.outputHandler((_command, stdout, stderr) => {
		let outputBytes = 0;
		const record = (chunk: Buffer | string): void => {
			if (outputController.signal.aborted) return;
			outputBytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
			if (outputBytes > GIT_COMMAND_OUTPUT_MAX_BYTES) {
				outputController.abort(new Error(`Git command output exceeded ${GIT_COMMAND_OUTPUT_MAX_BYTES} bytes`));
			}
		};
		stdout.on("data", record);
		stderr.on("data", record);
	});
	return repo;
}

export interface GitProjectScope {
	repo: ReturnType<typeof createGitClient>;
	gitRoot: string;
	/** Git-style, repository-root-relative path to the opened project. Empty at the root. */
	projectPrefix: string;
}

function isPathOutsideRoot(path: string): boolean {
	return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function canonicalRoot(repo: ReturnType<typeof createGitClient>): Promise<string> {
	const root = (await repo.revparse(["--show-toplevel"])).trim();
	if (root.length === 0) throw new Error("Git returned an empty repository root");
	return realpath(root);
}

export async function resolveGitProjectScope(cwd: string, signal?: AbortSignal): Promise<GitProjectScope | null> {
	const discoveredRepo = createGitClient(cwd, signal);
	if (!(await discoveredRepo.checkIsRepo())) return null;
	const [gitRoot, projectRoot] = await Promise.all([canonicalRoot(discoveredRepo), realpath(cwd)]);
	const nativePrefix = relative(gitRoot, projectRoot);
	if (isPathOutsideRoot(nativePrefix)) throw new Error("Git project is outside its repository root");
	const projectPrefix = nativePrefix.split(sep).join("/");
	if (projectPrefix.length > 0) assertGitPath(projectPrefix);
	return { repo: createGitClient(gitRoot, signal), gitRoot, projectPrefix };
}

export function toRepositoryPath(scope: GitProjectScope, projectPath: string): string {
	assertGitPath(projectPath);
	const repositoryPath = scope.projectPrefix.length === 0 ? projectPath : `${scope.projectPrefix}/${projectPath}`;
	assertGitPath(repositoryPath);
	return repositoryPath;
}

export function toProjectPath(scope: GitProjectScope, repositoryPath: string): string | null {
	assertGitPath(repositoryPath);
	if (scope.projectPrefix.length === 0) return repositoryPath;
	const prefix = `${scope.projectPrefix}/`;
	if (!repositoryPath.startsWith(prefix)) return null;
	const projectPath = repositoryPath.slice(prefix.length);
	assertGitPath(projectPath);
	return projectPath;
}

export function literalPathspec(path: string): string {
	return `:(literal)${path}`;
}

export function appendProjectPathspec(args: string[], scope: GitProjectScope): void {
	if (scope.projectPrefix.length > 0) args.push("--", literalPathspec(scope.projectPrefix));
}

export function scopedDiffArgs(scope: GitProjectScope, args: string[]): string[] {
	if (scope.projectPrefix.length > 0) args.push(`--relative=${scope.projectPrefix}`);
	return args;
}
