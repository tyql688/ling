import { isInside } from "@ling/core/paths";
import type { ChangeReviewPartialReason } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import { requireCommand, toCommandError } from "@ling/core/command-resolver";
import { assertGitPath, parseBatchedDiff } from "@ling/host/domains/git/git-output-parsers";
import { createLogger } from "@ling/core/logger";
import {
	createReviewFileIdentity,
	REVIEW_CAPTURE_EXCLUDED_DIRS,
	type ReviewSnapshotFile,
} from "@ling/core/change-review/change-review";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, opendir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const log = createLogger("change-review-shadow");
/** Shadow repo root directory name under userData; renaming orphans old object stores until cleanup. */
const SHADOW_ROOT_NAME = "change-review-shadow";
/**
 * How long shadow data with no session reference may live before GC. 7 days covers
 * "close the app over the weekend and reopen"; shorter could delete shadow repos of
 * sessions that may still be reopened.
 */
const SHADOW_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * Timeout for routine git plumbing (rev-parse / diff-tree etc). 30s covers medium repos;
 * a stuck git process must be killed, or it holds file locks.
 */
const GIT_COMMAND_TIMEOUT_MS = 30_000;
/**
 * Timeout for heavy whole-tree operations like `add` / `gc`. Large repos legitimately run
 * several times slower than plumbing; 2min is the acceptable ceiling — longer means stuck.
 */
const GIT_HEAVY_TIMEOUT_MS = 120_000;
/**
 * Cap for non-diff git output. 4MiB covers status/rev listings; guards against malicious
 * or anomalously huge stdout.
 */
const GIT_SMALL_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Cap for `git diff`-class output. 64MiB covers large-patch review; larger is unrenderable
 * in the UI anyway and should be truncated with an error.
 */
const GIT_DIFF_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/**
 * stderr buffer cap. 2MiB is plenty of diagnostics; prevents an error flood from eating memory.
 */
const GIT_STDERR_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Max files in a single snapshot. 75k ≈ the upper edge of dirty files in a large monorepo;
 * beyond that, fail visibly rather than build unbounded Maps/serializations.
 */
const SNAPSHOT_MAX_FILES = 75_000;
/**
 * Total content bytes counted into a single snapshot (2GiB). Prevents reading the whole
 * disk into the process.
 */
const SNAPSHOT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * Per-file counted cap (256MiB). Larger files only record metadata/skip the blob, so one
 * file cannot drag down capture.
 */
const SNAPSHOT_MAX_FILE_BYTES = 256 * 1024 * 1024;
/**
 * Run object-store maintenance every N captures. Capture only adds objects; gc once per
 * 64 keeps long sessions from piling up loose objects without paying gc cost per capture.
 */
const MAINTENANCE_CAPTURE_INTERVAL = 64;

type ShadowGitFailureCode = "CAPTURE_FAILED" | "CAPTURE_LIMIT_EXCEEDED";

class ShadowGitCaptureError extends Error {
	readonly code: ShadowGitFailureCode;

	constructor(code: ShadowGitFailureCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ShadowGitCaptureError";
		this.code = code;
	}
}

export interface ShadowGitCheckpoint {
	tree: string;
}

interface ShadowGitDiffResult {
	checkpoint: ShadowGitCheckpoint;
	files: ReviewSnapshotFile[];
}

export interface ShadowGitSession {
	start(): Promise<ShadowGitCheckpoint>;
	preview(from: ShadowGitCheckpoint): Promise<ShadowGitDiffResult>;
	finish(from: ShadowGitCheckpoint): Promise<ShadowGitDiffResult>;
	dispose(): Promise<void>;
}

interface GitRunOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	maxOutputBytes?: number;
	timeoutMs?: number;
}

function shadowRoot(userData: string): string {
	if (!isAbsolute(userData)) throw new Error("Ling user data path must be absolute");
	return join(userData, SHADOW_ROOT_NAME);
}

function sessionDigest(ref: SessionRef): string {
	return createHash("sha256").update(sessionKey(ref)).digest("hex");
}

function assertOwnedShadowPath(root: string, candidate: string): void {
	if (!isInside(resolve(root), resolve(candidate))) throw new Error("Shadow Git path escaped its storage root");
}

function shadowEnvironment(
	gitDir: string,
	workTree: string,
	indexFile: string,
	globalConfig: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
	}
	env.GIT_DIR = gitDir;
	env.GIT_WORK_TREE = workTree;
	env.GIT_INDEX_FILE = indexFile;
	env.GIT_CONFIG_GLOBAL = globalConfig;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_ATTR_NOSYSTEM = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	env.LC_ALL = "C";
	return env;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number, maxBytes: number): number {
	const nextBytes = currentBytes + chunk.byteLength;
	if (nextBytes > maxBytes)
		throw new ShadowGitCaptureError("CAPTURE_LIMIT_EXCEEDED", "Shadow Git output limit exceeded");
	chunks.push(chunk);
	return nextBytes;
}

function runGit(args: readonly string[], options: GitRunOptions): Promise<string> {
	const command = requireCommand("git");
	const maxOutputBytes = options.maxOutputBytes ?? GIT_SMALL_OUTPUT_MAX_BYTES;
	const timeoutMs = options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
	return new Promise((resolveRun, rejectRun) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let terminalError: Error | null = null;
		let settled = false;
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stop = (error: Error): void => {
			if (terminalError !== null) return;
			terminalError = error;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			// A timeout signals a stuck or slow Git process, not an oversized project,
			// so it must not surface as the capture-limit partial reason.
			stop(new ShadowGitCaptureError("CAPTURE_FAILED", `Shadow Git command exceeded ${timeoutMs} ms`));
		}, timeoutMs);
		child.stdout.on("data", (raw: Buffer) => {
			if (terminalError !== null) return;
			try {
				stdoutBytes = appendBounded(stdout, raw, stdoutBytes, maxOutputBytes);
			} catch (error) {
				stop(toCommandError(error));
			}
		});
		child.stderr.on("data", (raw: Buffer) => {
			if (terminalError !== null) return;
			try {
				stderrBytes = appendBounded(stderr, raw, stderrBytes, GIT_STDERR_MAX_BYTES);
			} catch (error) {
				stop(toCommandError(error));
			}
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectRun(toCommandError(error));
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (terminalError !== null) {
				rejectRun(terminalError);
				return;
			}
			if (code !== 0) {
				const detail = Buffer.concat(stderr).toString("utf8").trim();
				rejectRun(
					new ShadowGitCaptureError(
						"CAPTURE_FAILED",
						`Shadow Git command failed (code=${String(code)} signal=${String(signal)}): ${detail || args[0]}`,
					),
				);
				return;
			}
			resolveRun(Buffer.concat(stdout).toString("utf8"));
		});
	});
}

function parseTreeObjectId(output: string): string {
	const tree = output.trim();
	if (!/^[0-9a-f]{40,64}$/.test(tree)) {
		throw new ShadowGitCaptureError("CAPTURE_FAILED", "Shadow Git returned an invalid tree object id");
	}
	return tree;
}

function validateTreeInventory(output: string): void {
	let fileCount = 0;
	let totalBytes = 0;
	for (const record of output.split("\0")) {
		if (record.length === 0) continue;
		const tab = record.indexOf("\t");
		if (tab === -1) throw new ShadowGitCaptureError("CAPTURE_FAILED", "Shadow Git returned invalid tree inventory");
		const metadata = record.slice(0, tab).trim().split(/\s+/);
		const sizeRaw = metadata[3];
		const size = sizeRaw === undefined || sizeRaw === "-" ? 0 : Number.parseInt(sizeRaw, 10);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new ShadowGitCaptureError("CAPTURE_FAILED", "Shadow Git returned an invalid blob size");
		}
		fileCount += 1;
		totalBytes += size;
		if (fileCount > SNAPSHOT_MAX_FILES || size > SNAPSHOT_MAX_FILE_BYTES || totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) {
			throw new ShadowGitCaptureError("CAPTURE_LIMIT_EXCEEDED", "Project exceeds Shadow Git capture limits");
		}
	}
}

interface NameStatusRecord {
	path: string;
	from?: string;
	status: ReviewSnapshotFile["status"];
}

function parseNameStatus(output: string): NameStatusRecord[] {
	const fields = output.split("\0");
	const records: NameStatusRecord[] = [];
	for (let index = 0; index < fields.length;) {
		const statusRaw = fields[index];
		index += 1;
		if (!statusRaw) continue;
		const code = statusRaw[0];
		if (code === undefined) throw new ShadowGitCaptureError("CAPTURE_FAILED", "Missing Shadow Git status");
		if (code === "R" || code === "C") {
			const from = fields[index];
			const path = fields[index + 1];
			index += 2;
			if (!from || !path) throw new ShadowGitCaptureError("CAPTURE_FAILED", "Invalid Shadow Git rename record");
			assertGitPath(from);
			assertGitPath(path);
			records.push({ path, from, status: code === "R" ? "renamed" : "copied" });
			continue;
		}
		const path = fields[index];
		index += 1;
		if (!path) throw new ShadowGitCaptureError("CAPTURE_FAILED", "Invalid Shadow Git status record");
		assertGitPath(path);
		const status: ReviewSnapshotFile["status"] = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
		records.push({ path, status });
	}
	return records;
}

function mergePatchEntries(output: string): Map<string, { additions: number; deletions: number; diff: string }> {
	const merged = new Map<string, { additions: number; deletions: number; diff: string }>();
	for (const entry of parseBatchedDiff(output)) {
		const current = merged.get(entry.path);
		merged.set(entry.path, {
			additions: (current?.additions ?? 0) + entry.additions,
			deletions: (current?.deletions ?? 0) + entry.deletions,
			diff: current === undefined || current.diff.length === 0 ? entry.diff : `${current.diff}\n${entry.diff}`,
		});
	}
	return merged;
}

function buildReviewFiles(nameStatus: string, patchOutput: string): ReviewSnapshotFile[] {
	const patches = mergePatchEntries(patchOutput);
	const files = parseNameStatus(nameStatus).map((record): ReviewSnapshotFile => {
		const patch = patches.get(record.path);
		if (patch === undefined) {
			throw new ShadowGitCaptureError("CAPTURE_FAILED", `Shadow Git omitted patch data for ${record.path}`);
		}
		const file: ReviewSnapshotFile = {
			path: record.path,
			status: record.status,
			additions: patch.additions,
			deletions: patch.deletions,
			diff: patch.diff,
		};
		if (record.from !== undefined) file.from = record.from;
		file.identity = createReviewFileIdentity(file);
		return file;
	});
	if (patches.size !== files.length) {
		throw new ShadowGitCaptureError("CAPTURE_FAILED", "Shadow Git status and patch records did not match");
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeCaptureError(error: unknown): ShadowGitCaptureError {
	if (error instanceof ShadowGitCaptureError) return error;
	return new ShadowGitCaptureError("CAPTURE_FAILED", "Shadow Git capture failed", { cause: toCommandError(error) });
}

function gitConfigPathValue(path: string): string {
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Written as GIT_CONFIG_GLOBAL so the shadow never reads the user's real Git config.
 * That isolation also leaves LFS filters undefined: LFS-tracked files hash as their
 * raw content, bounded by SNAPSHOT_MAX_FILE_BYTES. */
function shadowGitConfig(excludesFile: string): string {
	return [
		"[core]",
		"\tautocrlf = false",
		"\tsafecrlf = false",
		"\tprotectNTFS = true",
		"\tprotectHFS = true",
		"\tlongpaths = true",
		"\tfsmonitor = false",
		"\tuntrackedCache = true",
		`\texcludesFile = ${gitConfigPathValue(excludesFile)}`,
		"[advice]",
		"\taddEmbeddedRepo = false",
		"[diff]",
		"\trenameLimit = 10000",
		"",
	].join("\n");
}

export function createShadowGitSession(userData: string, ref: SessionRef): ShadowGitSession {
	const root = shadowRoot(userData);
	const sessionRoot = join(root, sessionDigest(ref));
	const generationRoot = join(sessionRoot, randomUUID());
	const gitDir = join(generationRoot, "repo.git");
	const indexFile = join(generationRoot, "index");
	const globalConfig = join(generationRoot, "global-config");
	const globalExcludes = join(generationRoot, "global-excludes");
	const env = shadowEnvironment(gitDir, ref.cwd, indexFile, globalConfig);
	let initialized: Promise<void> | null = null;
	let validatedTree: string | null = null;
	let capturesSinceMaintenance = 0;
	let disposed = false;
	let disposal: Promise<void> | null = null;
	let operationTail: Promise<void> = Promise.resolve();

	assertOwnedShadowPath(root, sessionRoot);
	assertOwnedShadowPath(sessionRoot, generationRoot);

	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		const queued = operationTail.then(() => {
			if (disposed) throw new ShadowGitCaptureError("CAPTURE_FAILED", "Shadow Git session is disposed");
			return operation();
		});
		operationTail = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	const initialize = async (): Promise<void> => {
		await mkdir(generationRoot, { recursive: true });
		await Promise.all([
			writeFile(globalConfig, shadowGitConfig(globalExcludes), "utf8"),
			writeFile(globalExcludes, "", "utf8"),
		]);
		await runGit(["init", "--bare", "--quiet", gitDir], { cwd: generationRoot });
		await mkdir(join(gitDir, "info"), { recursive: true });
		await writeFile(
			join(gitDir, "info", "exclude"),
			`${REVIEW_CAPTURE_EXCLUDED_DIRS.map((dir) => `${dir}/`).join("\n")}\n`,
			"utf8",
		);
	};

	const ensureInitialized = async (): Promise<void> => {
		initialized ??= initialize();
		try {
			await initialized;
		} catch (error) {
			throw normalizeCaptureError(error);
		}
	};

	const captureTree = async (): Promise<ShadowGitCheckpoint> => {
		await ensureInitialized();
		// The generation-scoped index persists across captures on purpose: `add` can
		// then trust its stat cache and skip re-hashing unchanged files. `write-tree`
		// depends only on worktree content and excludes, never on the index seed.
		await runGit(["add", "--all", "--no-warn-embedded-repo", "--", "."], {
			cwd: ref.cwd,
			env,
			timeoutMs: GIT_HEAVY_TIMEOUT_MS,
		});
		const tree = parseTreeObjectId(await runGit(["write-tree"], { cwd: ref.cwd, env }));
		if (tree !== validatedTree) {
			validateTreeInventory(
				await runGit(["ls-tree", "-r", "-l", "-z", tree], {
					cwd: ref.cwd,
					env,
					maxOutputBytes: GIT_DIFF_OUTPUT_MAX_BYTES,
				}),
			);
			validatedTree = tree;
		}
		capturesSinceMaintenance += 1;
		return { tree };
	};

	/** Safe only right after `update-ref`: every object the session still needs is
	 * then reachable from refs/ling/latest, so `--prune=now` cannot orphan a capture. */
	const maintainObjectStore = async (): Promise<void> => {
		if (capturesSinceMaintenance < MAINTENANCE_CAPTURE_INTERVAL) return;
		capturesSinceMaintenance = 0;
		try {
			await runGit(["gc", "--quiet", "--prune=now"], { cwd: ref.cwd, env, timeoutMs: GIT_HEAVY_TIMEOUT_MS });
		} catch (error) {
			// Maintenance is opportunistic: the capture that triggered it already
			// succeeded, and disk growth stays bounded by generation disposal.
			log.error(`shadow git maintenance failed for ${ref.cwd}:`, error);
		}
	};

	const diffTrees = async (from: ShadowGitCheckpoint, to: ShadowGitCheckpoint): Promise<ReviewSnapshotFile[]> => {
		const diffBase = [
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--submodule=short",
			"--find-renames=50%",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			from.tree,
			to.tree,
		];
		const [nameStatus, patches] = await Promise.all([
			runGit([...diffBase.slice(0, -2), "--name-status", "-z", from.tree, to.tree], {
				cwd: ref.cwd,
				env,
				maxOutputBytes: GIT_DIFF_OUTPUT_MAX_BYTES,
			}),
			runGit(
				[
					...diffBase.slice(0, -2),
					"--numstat",
					"-z",
					"--patch",
					"--binary",
					"--output-indicator-new=+",
					"--output-indicator-old=-",
					"--output-indicator-context= ",
					from.tree,
					to.tree,
				],
				{ cwd: ref.cwd, env, maxOutputBytes: GIT_DIFF_OUTPUT_MAX_BYTES },
			),
		]);
		return buildReviewFiles(nameStatus, patches);
	};

	const captureDiff = async (from: ShadowGitCheckpoint, updateBaseline: boolean): Promise<ShadowGitDiffResult> => {
		try {
			const checkpoint = await captureTree();
			const files = checkpoint.tree === from.tree ? [] : await diffTrees(from, checkpoint);
			if (updateBaseline) {
				await runGit(["update-ref", "refs/ling/latest", checkpoint.tree], { cwd: ref.cwd, env });
				await maintainObjectStore();
			}
			return { checkpoint, files };
		} catch (error) {
			throw normalizeCaptureError(error);
		}
	};

	return {
		start: () =>
			run(async () => {
				try {
					const checkpoint = await captureTree();
					await runGit(["update-ref", "refs/ling/latest", checkpoint.tree], { cwd: ref.cwd, env });
					return checkpoint;
				} catch (error) {
					throw normalizeCaptureError(error);
				}
			}),
		preview: (from) => run(() => captureDiff(from, false)),
		finish: (from) => run(() => captureDiff(from, true)),
		dispose() {
			if (disposal) return disposal;
			disposed = true;
			// Every caller must wait for the same capture drain and filesystem cleanup.
			disposal = (async () => {
				await operationTail;
				await rm(generationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
				try {
					// rmdir is both streaming-free and atomic: a concurrent generation prevents removal.
					await rmdir(sessionRoot);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
				}
			})();
			return disposal;
		},
	};
}

export async function deleteShadowGitSessionData(userData: string, ref: SessionRef): Promise<void> {
	const root = shadowRoot(userData);
	const target = join(root, sessionDigest(ref));
	assertOwnedShadowPath(root, target);
	await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

export async function cleanupStaleShadowGitData(userData: string): Promise<void> {
	const root = shadowRoot(userData);
	const now = Date.now();
	let entries: Awaited<ReturnType<typeof opendir>>;
	try {
		entries = await opendir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for await (const entry of entries) {
		if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
		const target = join(root, entry.name);
		assertOwnedShadowPath(root, target);
		const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (info === null || now - info.mtimeMs < SHADOW_STALE_AFTER_MS) continue;
		await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
}

export function partialReasonForShadowFailure(error: unknown): ChangeReviewPartialReason {
	return error instanceof ShadowGitCaptureError && error.code === "CAPTURE_LIMIT_EXCEEDED"
		? "captureLimitExceeded"
		: "shadowCaptureFailed";
}
