import { looksBinary as looksBinaryBuffer } from "@ling/core/binary-detection";
import type {
	HostDirectoryListing,
	ProjectDirectoryEntry,
	ProjectDirectoryEntryKind,
	ProjectDirectoryListing,
	ProjectDroppedFileReferenceResult,
	ProjectFilePreview,
	ProjectFileReferenceTarget,
	ProjectImagePreviewMime,
	ProjectWriteFileResult,
} from "@ling/contracts/project";
import {
	PROJECT_DIRECTORY_MAX_ENTRIES,
	PROJECT_FILE_INDEX_MAX_ITEMS,
	PROJECT_FILE_INDEX_MAX_TOTAL_CHARS,
	PROJECT_FILE_REFERENCE_MAX_ITEMS,
	PROJECT_IMAGE_PREVIEW_MAX_BYTES,
	PROJECT_RELATIVE_PATH_MAX_CHARS,
	PROJECT_TEXT_PREVIEW_MAX_BYTES,
} from "@ling/contracts/project";
import { createLingError } from "@ling/core/ling-error";
import { errorCode } from "@ling/contracts/ling-error";
import { projectDirectoryMissing } from "@ling/host/runtime/project-directory";
import { createHash, randomUUID } from "node:crypto";
import { open, opendir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import pLimit from "p-limit";

/** Bytes read for binary sniffing; 8KiB identifies common magic numbers, more would slow directory previews. */
const BINARY_SNIFF_BYTES = 8 * 1_024;
/** Entries always omitted from directory enumeration; .git/.DS_Store have no product value and add bulk/noise. */
const DIRECTORY_OMISSIONS = new Set([".git", ".DS_Store"]);
/** Non-Git project indexing additionally skips dependency trees so one @ completion scan avoids hundreds of thousands of third-party files. */
const FILE_INDEX_DIRECTORY_OMISSIONS = new Set([...DIRECTORY_OMISSIONS, "node_modules"]);
/** Directory entry sort: en + numeric, matching the file manager's natural number order (file2 < file10). */
const ENTRY_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
/** Symlink classification concurrency limit; 16 balances large-directory stat throughput against fd/IO pressure. */
const SYMLINK_CLASSIFICATION_CONCURRENCY = 16;

const PROJECT_FILE_WRITE_BLOCK_CODES = ["EACCES", "EBUSY", "EPERM", "EROFS"] as const;
type ProjectFileWriteBlockCode = (typeof PROJECT_FILE_WRITE_BLOCK_CODES)[number];
type ProjectFileWriteStage = "write-temporary" | "verify-target" | "replace-target";

function projectFileWriteBlockCode(error: unknown): ProjectFileWriteBlockCode | null {
	if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return null;
	return PROJECT_FILE_WRITE_BLOCK_CODES.includes(error.code as ProjectFileWriteBlockCode)
		? (error.code as ProjectFileWriteBlockCode)
		: null;
}

async function projectFileWriteStep<Value>(
	stage: ProjectFileWriteStage,
	operation: () => Promise<Value>,
): Promise<Value> {
	try {
		return await operation();
	} catch (error) {
		const systemCode = projectFileWriteBlockCode(error);
		if (systemCode === null) throw error;
		throw createLingError(
			{
				code: "PROJECT_FILE_WRITE_BLOCKED",
				category: "external",
				message:
					"The project file could not be saved because it may be read-only, unavailable for writing, or locked by another program.",
				retryable: true,
				userAction: "retry",
				details: { resource: "project-file", stage, systemCode },
			},
			error,
		);
	}
}

function assertInsideWorkspace(root: string, candidate: string): void {
	const rel = relative(root, candidate);
	if (rel === "") return;
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Path escapes workspace: ${candidate}`);
	}
}

function projectPathSegments(inputPath: string): string[] {
	if (inputPath === "") return [];
	if (
		isAbsolute(inputPath) ||
		(process.platform === "win32" && inputPath.includes("\\")) ||
		inputPath.includes("\0") ||
		inputPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
	) {
		throw new Error(`Invalid project-relative path: ${inputPath}`);
	}
	return inputPath.split("/");
}

function childProjectPath(parentPath: string, name: string): string {
	return parentPath.length === 0 ? name : `${parentPath}/${name}`;
}

/** Resolves the project root for a file operation, reporting a deleted folder as such. */
async function projectRootRealPath(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		throw projectDirectoryMissing(root, error);
	}
}

async function resolveExistingProjectPathFromRoot(rootRealPath: string, inputPath: string): Promise<string> {
	const candidate = resolve(rootRealPath, ...projectPathSegments(inputPath));
	assertInsideWorkspace(rootRealPath, candidate);
	const candidateRealPath = await realpath(candidate);
	assertInsideWorkspace(rootRealPath, candidateRealPath);
	return candidateRealPath;
}

/** Resolves symlinks and proves that the existing target remains inside the project root. */
export async function resolveExistingProjectPath(root: string, inputPath: string): Promise<string> {
	return resolveExistingProjectPathFromRoot(await projectRootRealPath(root), inputPath);
}

async function resolveDroppedFileReferenceFromRoot(
	rootRealPath: string,
	filePath: string,
): Promise<ProjectDroppedFileReferenceResult> {
	if (!isAbsolute(filePath) || filePath.includes("\0")) return { status: "unavailable" };
	let fileRealPath: string;
	try {
		fileRealPath = await realpath(filePath);
		if (!(await stat(fileRealPath)).isFile()) return { status: "unavailable" };
	} catch {
		return { status: "unavailable" };
	}
	const relativePath = relative(rootRealPath, fileRealPath);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return { status: "ok", reference: { scope: "external", path: fileRealPath } };
	}
	const path = relativePath.split(sep).join("/");
	return path.length <= PROJECT_RELATIVE_PATH_MAX_CHARS
		? { status: "ok", reference: { scope: "project", path } }
		: { status: "unavailable" };
}

export async function resolveProjectFileReferencePath(
	root: string,
	reference: ProjectFileReferenceTarget,
): Promise<string> {
	if (reference.scope === "project") return resolveExistingProjectPath(root, reference.path);
	if (!isAbsolute(reference.path) || reference.path.includes("\0")) throw new Error("Invalid external file reference");
	const filePath = await realpath(reference.path);
	if (!(await stat(filePath)).isFile()) throw new Error("External file reference is not a file");
	return filePath;
}

/** Resolves one bounded drop batch in parallel while canonicalizing the project root once. */
export async function resolveDroppedFileReferences(
	root: string,
	filePaths: readonly string[],
): Promise<ProjectDroppedFileReferenceResult[]> {
	if (filePaths.length > PROJECT_FILE_REFERENCE_MAX_ITEMS) throw new Error("Too many dropped file references");
	const rootRealPath = await projectRootRealPath(root);
	return Promise.all(filePaths.map((filePath) => resolveDroppedFileReferenceFromRoot(rootRealPath, filePath)));
}

function entryKindRank(kind: ProjectDirectoryEntryKind): number {
	if (kind === "directory") return 0;
	if (kind === "file") return 1;
	return 2;
}

async function classifySymbolicLink(
	rootRealPath: string,
	parentPath: string,
	name: string,
): Promise<ProjectDirectoryEntry> {
	const path = childProjectPath(parentPath, name);
	try {
		const target = await resolveExistingProjectPathFromRoot(rootRealPath, path);
		const targetInfo = await stat(target);
		return {
			name,
			path,
			kind: targetInfo.isDirectory() ? "directory" : targetInfo.isFile() ? "file" : "unavailable",
			symbolicLink: true,
		};
	} catch {
		return { name, path, kind: "unavailable", symbolicLink: true };
	}
}

/** Non-Git fallback corpus for @ mentions. It walks metadata only, skips symlinks and
 * dependency trees, and stops at the same bounded scale as the Git-backed index. */
export async function listProjectFiles(root: string): Promise<string[]> {
	const rootRealPath = await projectRootRealPath(root);
	const pending = [{ absolutePath: rootRealPath, projectPath: "" }];
	const files: string[] = [];
	let filePathChars = 0;
	let nextDirectory = 0;
	while (nextDirectory < pending.length && files.length < PROJECT_FILE_INDEX_MAX_ITEMS) {
		const directory = pending[nextDirectory++];
		if (directory === undefined) break;
		const directoryRealPath = await realpath(directory.absolutePath);
		assertInsideWorkspace(rootRealPath, directoryRealPath);
		for await (const entry of await opendir(directoryRealPath)) {
			if (entry.isSymbolicLink() || FILE_INDEX_DIRECTORY_OMISSIONS.has(entry.name)) {
				continue;
			}
			const projectPath = childProjectPath(directory.projectPath, entry.name);
			if (projectPath.length > PROJECT_RELATIVE_PATH_MAX_CHARS) continue;
			if (entry.isDirectory()) {
				// A directory-only tree must not grow the queue without ever hitting the file cap.
				if (pending.length < PROJECT_FILE_INDEX_MAX_ITEMS) {
					pending.push({ absolutePath: resolve(directoryRealPath, entry.name), projectPath });
				}
			} else if (entry.isFile()) {
				if (filePathChars + projectPath.length > PROJECT_FILE_INDEX_MAX_TOTAL_CHARS) return files;
				files.push(projectPath);
				filePathChars += projectPath.length;
				if (files.length >= PROJECT_FILE_INDEX_MAX_ITEMS) break;
			}
		}
	}
	return files;
}

export async function listProjectDirectory(root: string, inputPath: string): Promise<ProjectDirectoryListing> {
	const rootRealPath = await projectRootRealPath(root);
	const directoryPath = await resolveExistingProjectPathFromRoot(rootRealPath, inputPath);

	const entries: ProjectDirectoryEntry[] = [];
	const symbolicLinks: {
		entryIndex: number;
		name: string;
	}[] = [];
	let truncated = false;
	const directory = await opendir(directoryPath);
	for await (const entry of directory) {
		if (DIRECTORY_OMISSIONS.has(entry.name)) continue;
		if (entries.length >= PROJECT_DIRECTORY_MAX_ENTRIES) {
			truncated = true;
			break;
		}
		if (entry.isSymbolicLink()) {
			symbolicLinks.push({
				entryIndex: entries.length,
				name: entry.name,
			});
			entries.push({
				name: entry.name,
				path: childProjectPath(inputPath, entry.name),
				kind: "unavailable",
				symbolicLink: true,
			});
			continue;
		}
		entries.push({
			name: entry.name,
			path: childProjectPath(inputPath, entry.name),
			kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unavailable",
			symbolicLink: false,
		});
	}
	const classify = pLimit(SYMLINK_CLASSIFICATION_CONCURRENCY);
	await Promise.all(
		symbolicLinks.map((link) =>
			classify(async () => {
				entries[link.entryIndex] = await classifySymbolicLink(rootRealPath, inputPath, link.name);
			}),
		),
	);
	entries.sort((left, right) => {
		const kindOrder = entryKindRank(left.kind) - entryKindRank(right.kind);
		return kindOrder === 0 ? ENTRY_COLLATOR.compare(left.name, right.name) : kindOrder;
	});
	return { path: inputPath, entries, truncated };
}

/** Authenticated project selection may browse folder names before opening a project, never file contents. */
export async function browseHostDirectories(input: string): Promise<HostDirectoryListing> {
	try {
		const path = await realpath(input);
		const root = parse(path).root;
		const listing = await listProjectDirectory(root, relative(root, path).split(sep).join("/"));
		const parent = dirname(path);
		return {
			path,
			parent: parent === path ? null : parent,
			entries: listing.entries
				.filter((entry) => entry.kind !== "file")
				.map((entry) => ({
					name: entry.name,
					path: resolve(root, entry.path),
					unavailable: entry.kind === "unavailable",
				})),
			truncated: listing.truncated,
		};
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "EPERM" && code !== "ELOOP")
			throw error;
		throw createLingError(
			{
				code: "HOST_DIRECTORY_UNAVAILABLE",
				category: "external",
				message: "This folder could not be read. Check the path and access permissions.",
				retryable: true,
				details: { path: input, systemCode: code },
			},
			error,
		);
	}
}

function startsWithBytes(buffer: Buffer, bytes: readonly number[]): boolean {
	return bytes.every((byte, index) => buffer[index] === byte);
}

function asciiAt(buffer: Buffer, start: number, text: string): boolean {
	if (buffer.length < start + text.length) return false;
	return buffer.toString("ascii", start, start + text.length) === text;
}

/** Mime types the review pane can render; the image set plus the two container formats skins already play. */
type PreviewMediaMime = ProjectImagePreviewMime | "video/mp4" | "video/webm";

/** Image magic numbers first, so an AVIF is not mistaken for the MP4 family it shares `ftyp` with. */
export function detectPreviewMediaMime(buffer: Buffer): PreviewMediaMime | null {
	const image = detectImageMime(buffer);
	if (image !== null) return image;
	if (startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
	return asciiAt(buffer, 4, "ftyp") ? "video/mp4" : null;
}

function detectImageMime(buffer: Buffer): ProjectImagePreviewMime | null {
	if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (asciiAt(buffer, 0, "GIF87a") || asciiAt(buffer, 0, "GIF89a")) return "image/gif";
	if (asciiAt(buffer, 0, "RIFF") && asciiAt(buffer, 8, "WEBP")) return "image/webp";
	if (startsWithBytes(buffer, [0x42, 0x4d])) return "image/bmp";
	if (asciiAt(buffer, 4, "ftyp") && (asciiAt(buffer, 8, "avif") || asciiAt(buffer, 8, "avis"))) {
		return "image/avif";
	}
	return null;
}

function decodeUtf8(buffer: Buffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return null;
	}
}

function textRevision(buffer: Uint8Array): string {
	return createHash("sha256").update(buffer).digest("hex");
}

async function readHandle(handle: Awaited<ReturnType<typeof open>>, size: number, maxBytes: number): Promise<Buffer> {
	if (size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read boundary`);
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return offset === size ? buffer : buffer.subarray(0, offset);
}

/**
 * Locates a previewable media file inside the project and identifies it from its header.
 * `readProjectFilePreview` answers `binary` for a clip because a transcript cannot draw one, but a
 * review can play it. Only the header is read: the caller streams the body, since a media element
 * asks for ranges rather than the whole file. Null when the path is not media Ling renders.
 */
export async function resolveWorkspaceMediaFile(
	root: string,
	inputPath: string,
	maxBytes: number,
): Promise<{ filePath: string; mime: PreviewMediaMime } | null> {
	const filePath = await resolveExistingProjectPath(root, inputPath);
	const handle = await open(filePath, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
		const headerLength = Math.min(info.size, BINARY_SNIFF_BYTES);
		const header = Buffer.alloc(headerLength);
		await handle.read(header, 0, headerLength, 0);
		const mime = detectPreviewMediaMime(header);
		return mime === null ? null : { filePath, mime };
	} finally {
		await handle.close();
	}
}

export async function readProjectFilePreview(root: string, inputPath: string): Promise<ProjectFilePreview> {
	const filePath = await resolveExistingProjectPath(root, inputPath);
	const handle = await open(filePath, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`Project path is not a file: ${inputPath}`);
		const headerLength = Math.min(info.size, BINARY_SNIFF_BYTES);
		const header = Buffer.alloc(headerLength);
		if (headerLength > 0) await handle.read(header, 0, headerLength, 0);
		const imageMime = detectImageMime(header);
		const metadata = { path: inputPath, size: info.size, modifiedAt: info.mtimeMs };

		if (imageMime !== null) {
			if (info.size > PROJECT_IMAGE_PREVIEW_MAX_BYTES) {
				return { ...metadata, kind: "tooLarge", maxBytes: PROJECT_IMAGE_PREVIEW_MAX_BYTES };
			}
			const contents = await readHandle(handle, info.size, PROJECT_IMAGE_PREVIEW_MAX_BYTES);
			return {
				...metadata,
				kind: "image",
				mime: imageMime,
				data: Uint8Array.from(contents),
			};
		}
		if (looksBinaryBuffer(header, BINARY_SNIFF_BYTES)) return { ...metadata, kind: "binary" };
		if (info.size > PROJECT_TEXT_PREVIEW_MAX_BYTES) {
			return { ...metadata, kind: "tooLarge", maxBytes: PROJECT_TEXT_PREVIEW_MAX_BYTES };
		}
		const contents = await readHandle(handle, info.size, PROJECT_TEXT_PREVIEW_MAX_BYTES);
		const content = decodeUtf8(contents);
		return content === null
			? { ...metadata, kind: "binary" }
			: { ...metadata, kind: "text", content, revision: textRevision(contents) };
	} finally {
		await handle.close();
	}
}

/** One Host file domain serializes saves by canonical target, including symlink aliases.
 * Settled queues release themselves; admitted requests keep their project lifecycle lease. */
export function createProjectFileWriter() {
	const tails = new Map<string, Promise<void>>();
	return async (
		root: string,
		inputPath: string,
		content: string,
		expectedRevision: string,
	): Promise<ProjectWriteFileResult> => {
		const target = await resolveExistingProjectPath(root, inputPath);
		const previous = tails.get(target) ?? Promise.resolve();
		const operation = previous.then(() => writeProjectTextFile(root, inputPath, content, expectedRevision, target));
		const release = () => {
			if (tails.get(target) === settled) tails.delete(target);
		};
		// Failure is returned to the caller; it must not poison subsequent saves in this queue.
		const settled = operation.then(release, release);
		tails.set(target, settled);
		return operation;
	};
}

async function writeProjectTextFile(
	root: string,
	inputPath: string,
	content: string,
	expectedRevision: string,
	expectedTarget: string,
): Promise<ProjectWriteFileResult> {
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length > PROJECT_TEXT_PREVIEW_MAX_BYTES) {
		throw new Error(`Workspace file exceeds the ${PROJECT_TEXT_PREVIEW_MAX_BYTES}-byte editor boundary`);
	}
	if (looksBinaryBuffer(bytes, BINARY_SNIFF_BYTES))
		throw new Error(`Workspace file content appears to be binary: ${inputPath}`);
	const filePath = await resolveExistingProjectPath(root, inputPath);
	if (filePath !== expectedTarget) {
		throw createLingError({
			code: "STALE_STATE_REVISION",
			category: "lifecycle",
			message: `The file target changed while waiting to save: ${inputPath}`,
			retryable: true,
			userAction: "retry",
			details: { resource: "workspace-file", path: inputPath },
		});
	}
	const handle = await open(filePath, "r");
	let initialInfo: Awaited<ReturnType<typeof handle.stat>>;
	try {
		initialInfo = await handle.stat();
		if (!initialInfo.isFile()) throw new Error(`Project path is not a file: ${inputPath}`);
		const current = await readHandle(handle, initialInfo.size, PROJECT_TEXT_PREVIEW_MAX_BYTES);
		if (textRevision(current) !== expectedRevision) {
			throw createLingError({
				code: "STALE_STATE_REVISION",
				category: "lifecycle",
				message: `The file changed on disk after it was opened: ${inputPath}`,
				retryable: true,
				userAction: "retry",
				details: { resource: "workspace-file", path: inputPath },
			});
		}
	} finally {
		await handle.close();
	}

	const temporaryPath = join(dirname(filePath), `.${randomUUID()}.ling-save`);
	try {
		await projectFileWriteStep("write-temporary", () =>
			writeFile(temporaryPath, bytes, { flag: "wx", mode: initialInfo.mode }),
		);
		const beforeReplace = await projectFileWriteStep("verify-target", () => stat(filePath));
		if (
			beforeReplace.size !== initialInfo.size ||
			beforeReplace.mtimeMs !== initialInfo.mtimeMs ||
			beforeReplace.ino !== initialInfo.ino
		) {
			throw createLingError({
				code: "STALE_STATE_REVISION",
				category: "lifecycle",
				message: `The file changed while it was being saved: ${inputPath}`,
				retryable: true,
				userAction: "retry",
				details: { resource: "workspace-file", path: inputPath },
			});
		}
		await projectFileWriteStep("replace-target", () => rename(temporaryPath, filePath));
		const saved = await stat(filePath);
		return {
			path: inputPath,
			size: saved.size,
			modifiedAt: saved.mtimeMs,
			revision: textRevision(bytes),
		};
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export async function readWorkspaceTextFile(
	root: string,
	inputPath: string,
	options: { maxBytes: number },
): Promise<string> {
	const filePath = await resolveExistingProjectPath(root, inputPath);
	const handle = await open(filePath, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`Workspace path is not a file: ${inputPath}`);
		if (info.size > options.maxBytes) throw new Error(`Workspace file is too large: ${inputPath}`);
		const contents = await readHandle(handle, info.size, options.maxBytes);
		if (looksBinaryBuffer(contents, BINARY_SNIFF_BYTES))
			throw new Error(`Workspace file appears to be binary: ${inputPath}`);
		const content = decodeUtf8(contents);
		if (content === null) throw new Error(`Workspace file is not valid UTF-8: ${inputPath}`);
		return content;
	} finally {
		await handle.close();
	}
}
