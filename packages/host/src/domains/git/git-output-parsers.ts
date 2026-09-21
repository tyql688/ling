import type { GitChangedFile, GitChangedFileStatus, WorktreeInfo } from "@ling/contracts/git";
import { GIT_PATH_MAX_CHARS } from "@ling/contracts/git";
import { isAbsolute } from "node:path";

/** Prefixes recognizing unified/combined patch file headers; aligned with the git diff output format, used to split multi-file patches. */
const GIT_PATCH_HEADERS = ["diff --git ", "diff --cc ", "diff --combined "] as const;

export interface GitStatusFile {
	from?: string;
	path: string;
	index: string;
	working_dir: string;
}

export interface GitDiffStat {
	additions: number;
	deletions: number;
}

export interface BatchedDiffEntry extends GitDiffStat {
	path: string;
	diff: string;
}

export function assertGitPath(path: unknown): asserts path is string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.length > GIT_PATH_MAX_CHARS ||
		isAbsolute(path) ||
		path.includes("\0") ||
		(process.platform === "win32" ? path.split(/[/\\]/) : path.split("/")).includes("..")
	) {
		throw new Error(`Invalid git path: ${String(path)}`);
	}
}

function mapStatusCode(index: string, workingDir: string): GitChangedFileStatus {
	const codes = [index, workingDir];
	if (codes.includes("U") || (index === "A" && workingDir === "A") || (index === "D" && workingDir === "D")) {
		return "conflicted";
	}
	if (codes.includes("?")) return "untracked";
	if (codes.includes("R")) return "renamed";
	if (codes.includes("C")) return "copied";
	if (codes.includes("A")) return "added";
	if (codes.includes("D")) return "deleted";
	return "modified";
}

/** Parses `git diff --numstat -z`, including its three-field rename/copy form. */
export function parseDiffNumstat(output: string): Map<string, GitDiffStat> {
	const stats = new Map<string, GitDiffStat>();
	let offset = 0;
	while (offset < output.length) {
		const end = output.indexOf("\0", offset);
		if (end === -1) throw new Error("Invalid NUL-delimited git numstat output");
		const record = output.slice(offset, end);
		offset = end + 1;
		if (record.length === 0) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) throw new Error("Invalid git numstat record");
		const additionsRaw = record.slice(0, firstTab);
		const deletionsRaw = record.slice(firstTab + 1, secondTab);
		let path = record.slice(secondTab + 1);
		if (path.length === 0) {
			const sourceEnd = output.indexOf("\0", offset);
			if (sourceEnd === -1) throw new Error("Invalid git numstat source path");
			offset = sourceEnd + 1;
			const targetEnd = output.indexOf("\0", offset);
			if (targetEnd === -1) throw new Error("Invalid git numstat target path");
			path = output.slice(offset, targetEnd);
			offset = targetEnd + 1;
		}
		assertGitPath(path);
		const additions = additionsRaw === "-" ? 0 : Number.parseInt(additionsRaw, 10);
		const deletions = deletionsRaw === "-" ? 0 : Number.parseInt(deletionsRaw, 10);
		if (Number.isNaN(additions) || Number.isNaN(deletions)) throw new Error("Invalid git numstat values");
		const current = stats.get(path) ?? { additions: 0, deletions: 0 };
		stats.set(path, { additions: current.additions + additions, deletions: current.deletions + deletions });
	}
	return stats;
}

/** Maps a `diff-tree` raw status letter; R/C carry a similarity score such as `R100`. */
function mapDiffTreeStatus(code: string): GitChangedFileStatus {
	switch (code[0]) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "M":
		case "T":
			// A type change still reads as a modification to the user.
			return "modified";
		default:
			throw new Error(`Invalid Git raw diff status: ${code}`);
	}
}

/**
 * Parses `git show` or `git diff` with `-z --raw --numstat`: one raw record per file, then the
 * numstat records.
 *
 *     :<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0 … <adds>\t<dels>\t<path>\0
 *
 * Raw carries the status and rename source, numstat the line counts; asking for both in one
 * call is the only way to get them together, because two format flags would override each other.
 * `--format=` suppresses the commit header, so the stream starts at the first raw record.
 */
export function parseRawDiffWithNumstat(output: string): GitChangedFile[] {
	if (output.length === 0) return [];
	let offset = 0;

	const files: GitChangedFile[] = [];
	while (offset < output.length && output[offset] === ":") {
		const header = readNullTerminated(output, offset, "git diff-tree raw header");
		offset = header.nextOffset;
		const status = mapDiffTreeStatus(header.value.slice(header.value.lastIndexOf(" ") + 1));
		const first = readNullTerminated(output, offset, "git diff-tree path");
		offset = first.nextOffset;
		if (status === "renamed" || status === "copied") {
			const target = readNullTerminated(output, offset, "git diff-tree rename target");
			offset = target.nextOffset;
			assertGitPath(first.value);
			assertGitPath(target.value);
			files.push({ path: target.value, status, from: first.value });
			continue;
		}
		assertGitPath(first.value);
		files.push({ path: first.value, status });
	}

	// Whatever follows the raw records is the numstat stream, which the shared parser already
	// handles including its three-field rename form.
	const stats = parseDiffNumstat(output.slice(offset));
	return files.map((file) => {
		const stat = stats.get(file.path);
		return stat === undefined ? file : { ...file, additions: stat.additions, deletions: stat.deletions };
	});
}

export function mapStatusFilesToChangedFiles(
	files: readonly GitStatusFile[],
	statsByPath: ReadonlyMap<string, GitDiffStat> = new Map(),
): GitChangedFile[] {
	return files
		.map((file) => {
			assertGitPath(file.path);
			const stat = statsByPath.get(file.path);
			const changedFile: GitChangedFile = {
				path: file.path,
				status: mapStatusCode(file.index, file.working_dir),
			};
			if (file.from) {
				assertGitPath(file.from);
				changedFile.from = file.from;
			}
			if (stat) {
				changedFile.additions = stat.additions;
				changedFile.deletions = stat.deletions;
			}
			return changedFile;
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

function parseDiffStat(value: string): number {
	if (value === "-") return 0;
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) throw new Error(`Invalid git diff stat: ${value}`);
	return parsed;
}

function readNullTerminated(output: string, offset: number, label: string): { value: string; nextOffset: number } {
	const end = output.indexOf("\0", offset);
	if (end === -1) throw new Error(`Invalid NUL-delimited Git diff ${label}`);
	return { value: output.slice(offset, end), nextOffset: end + 1 };
}

function isGitPatchHeaderAt(output: string, offset: number): boolean {
	const previous = offset === 0 ? -1 : output.charCodeAt(offset - 1);
	if (previous !== -1 && previous !== 0 && previous !== 10) return false;
	return GIT_PATCH_HEADERS.some((header) => output.startsWith(header, offset));
}

function findNextGitPatchHeader(output: string, offset: number): number {
	let cursor = offset;
	while (cursor < output.length) {
		const newline = output.indexOf("\n", cursor);
		if (newline === -1) return -1;
		const candidate = newline + 1;
		if (isGitPatchHeaderAt(output, candidate)) return candidate;
		cursor = candidate;
	}
	return -1;
}

function patchHeaderLine(patch: string): string {
	const end = patch.indexOf("\n");
	if (end === -1) throw new Error("Invalid Git patch header");
	return patch.slice(0, end);
}

function hasModeLine(patch: string, kind: "deleted" | "new"): boolean {
	return new RegExp(`(?:^|\\n)${kind} file mode [0-7]+(?:\\n|$)`).test(patch);
}

/** Git renders a file↔symlink/submodule type change as adjacent delete/add patches even though
 * numstat reports one logical file. Their identical headers let the parser retain both bodies in
 * that file's single review entry without interpreting Git's quoted path syntax. */
function isSplitTypeChange(previous: string, current: string): boolean {
	if (patchHeaderLine(previous) !== patchHeaderLine(current)) return false;
	return (
		(hasModeLine(previous, "deleted") && hasModeLine(current, "new")) ||
		(hasModeLine(previous, "new") && hasModeLine(current, "deleted"))
	);
}

/** Parses the NUL numstat prefix followed by stable Git patch records. */
export function parseBatchedDiff(output: string): BatchedDiffEntry[] {
	if (output.length === 0) return [];
	const stats: Array<{ path: string; additions: number; deletions: number }> = [];
	let offset = 0;
	while (offset < output.length) {
		const record = readNullTerminated(output, offset, "record");
		offset = record.nextOffset;
		if (record.value.length === 0) break;
		const firstTab = record.value.indexOf("\t");
		const secondTab = firstTab === -1 ? -1 : record.value.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) throw new Error("Invalid git numstat record");
		const additions = parseDiffStat(record.value.slice(0, firstTab));
		const deletions = parseDiffStat(record.value.slice(firstTab + 1, secondTab));
		let path = record.value.slice(secondTab + 1);
		if (path.length === 0) {
			const source = readNullTerminated(output, offset, "rename source path");
			const target = readNullTerminated(output, source.nextOffset, "rename target path");
			path = target.value;
			offset = target.nextOffset;
		}
		assertGitPath(path);
		stats.push({ path, additions, deletions });
	}
	const patches: string[] = [];
	let patchOffset = offset;
	while (patchOffset < output.length) {
		if (!isGitPatchHeaderAt(output, patchOffset)) {
			throw new Error(`Git diff record mismatch: ${stats.length} stats and ${patches.length} patches`);
		}
		const nextPatchOffset = findNextGitPatchHeader(output, patchOffset + 1);
		const patchEnd = nextPatchOffset === -1 ? output.length : nextPatchOffset;
		const patch = output.slice(patchOffset, patchEnd);
		const previousIndex = patches.length - 1;
		const previous = patches[previousIndex];
		if (previous !== undefined && isSplitTypeChange(previous, patch)) patches[previousIndex] = `${previous}${patch}`;
		else patches.push(patch);
		patchOffset = patchEnd;
	}
	if (patches.length !== stats.length) {
		throw new Error(`Git diff record mismatch: ${stats.length} stats and ${patches.length} patches`);
	}
	return stats.map((stat, index) => {
		const diff = patches[index];
		if (diff === undefined) throw new Error("Git diff patch disappeared during parsing");
		return { ...stat, diff };
	});
}

export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
	const entries: Array<Record<string, string | true>> = [];
	let current: Record<string, string | true> | null = null;
	for (const line of output.split(/\r?\n/)) {
		if (line.length === 0) {
			if (current) entries.push(current);
			current = null;
			continue;
		}
		current ??= {};
		const [key, ...rest] = line.split(" ");
		if (key) current[key] = rest.length > 0 ? rest.join(" ") : true;
	}
	if (current) entries.push(current);
	return entries.flatMap((entry, index) => {
		// Git retains deleted worktree registrations until pruning. They are not live checkouts.
		if (index > 0 && "prunable" in entry) return [];
		const path = typeof entry.worktree === "string" ? entry.worktree : "";
		const branch = typeof entry.branch === "string" ? entry.branch.replace(/^refs\/heads\//, "") : null;
		return [
			{
				path,
				canonicalPath: path,
				branchName: branch,
				headSha: typeof entry.HEAD === "string" ? entry.HEAD : "",
				detached: entry.detached === true || branch === null,
				primary: index === 0,
			},
		];
	});
}
