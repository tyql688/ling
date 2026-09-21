import {
	isSkinAssetPath,
	isSkinVideoAsset,
	SKIN_ID_PATTERN,
	SKIN_MANIFEST_FILE,
	SKIN_MANIFEST_MAX_BYTES,
	SKIN_MEDIA_IMAGE_MAX_BYTES,
	SKIN_MEDIA_VIDEO_MAX_BYTES,
	SKIN_PACKAGE_MAX_COUNT,
	skinManifestSchema,
	type SkinManifest,
	type UserSkinSnapshot,
	type UserSkinsSnapshot,
} from "@ling/contracts/skins";
import { toError } from "@ling/core/ling-error";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SKINS_DIR = join(homedir(), ".ling", "skins");
/** One extra byte distinguishes a file at the limit from one that grew during the bounded read. */
const SKIN_MANIFEST_READ_BYTES = SKIN_MANIFEST_MAX_BYTES + 1;

function invalidSkin(id: string, revision: number, error: string): UserSkinSnapshot {
	return { id, revision, manifest: null, error };
}

function validationMessage(manifest: unknown): { manifest: SkinManifest | null; error: string | null } {
	const parsed = skinManifestSchema.safeParse(manifest);
	if (parsed.success) return { manifest: parsed.data, error: null };
	const message = parsed.error.issues
		.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
		.join("; ");
	return { manifest: null, error: message };
}

export async function ensureSkinsDirectory(): Promise<void> {
	await mkdir(SKINS_DIR, { recursive: true });
}

function resolveSkinAssetPath(packageRoot: string, asset: string): string {
	if (!isSkinAssetPath(asset)) throw new Error("Invalid skin asset reference");
	const file = resolve(packageRoot, ...asset.split("/"));
	const withinPackage = relative(packageRoot, file);
	if (
		withinPackage.length === 0 ||
		withinPackage === ".." ||
		withinPackage.startsWith(`..${sep}`) ||
		isAbsolute(withinPackage)
	) {
		throw new Error("Skin asset escapes its package");
	}
	return file;
}

function pathIsInside(root: string, candidate: string): boolean {
	const withinRoot = relative(root, candidate);
	return withinRoot.length > 0 && withinRoot !== ".." && !withinRoot.startsWith(`..${sep}`) && !isAbsolute(withinRoot);
}

async function resolveExistingSkinPackageRoot(id: string): Promise<string> {
	if (!SKIN_ID_PATTERN.test(id)) throw new Error("Invalid skin id");
	const skinsRoot = await realpath(SKINS_DIR);
	const packageRoot = await realpath(resolve(SKINS_DIR, id));
	if (!pathIsInside(skinsRoot, packageRoot)) {
		throw new Error("Skin package escapes the skins directory through a symbolic link");
	}
	return packageRoot;
}

async function resolveExistingSkinAssetPath(id: string, asset: string): Promise<string> {
	const packageRoot = await resolveExistingSkinPackageRoot(id);
	const lexicalPath = resolveSkinAssetPath(packageRoot, asset);
	const file = await realpath(lexicalPath);
	if (!pathIsInside(packageRoot, file)) throw new Error("Skin asset escapes its package through a symbolic link");
	return file;
}

export async function openExistingSkinAsset(id: string, asset: string): Promise<FileHandle> {
	const file = await resolveExistingSkinAssetPath(id, asset);
	const safetyFlags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
	return open(file, constants.O_RDONLY | safetyFlags);
}

async function validateArtworkAsset(id: string, asset: string): Promise<string | null> {
	let handle: FileHandle;
	try {
		handle = await openExistingSkinAsset(id, asset);
	} catch (error) {
		const normalized = toError(error);
		if ((normalized as NodeJS.ErrnoException).code === "ENOENT") return `missing asset ${asset}`;
		return normalized.message;
	}
	try {
		const info = await handle.stat();
		const maxBytes = isSkinVideoAsset(asset) ? SKIN_MEDIA_VIDEO_MAX_BYTES : SKIN_MEDIA_IMAGE_MAX_BYTES;
		if (!info.isFile()) return `asset is not a file: ${asset}`;
		if (info.size === 0) return `asset is empty: ${asset}`;
		if (info.size > maxBytes) return `asset exceeds its size limit: ${asset}`;
		return null;
	} finally {
		await handle.close();
	}
}

async function validateManifestAssets(id: string, manifest: SkinManifest): Promise<string | null> {
	const designs = manifest.kind === "art" ? [manifest.mode] : Object.values(manifest.modes);
	for (const mode of designs) {
		const artwork = mode.artwork;
		if (artwork?.media !== null && artwork?.media !== undefined) {
			const error = await validateArtworkAsset(id, artwork.media);
			if (error !== null) return error;
		}
		if (artwork?.poster !== null && artwork?.poster !== undefined) {
			const error = await validateArtworkAsset(id, artwork.poster);
			if (error !== null) return error;
		}
	}
	return null;
}

async function readSkinPackage(id: string, revision: number): Promise<UserSkinSnapshot> {
	const packageRoot = await resolveExistingSkinPackageRoot(id);
	let manifestPath: string;
	try {
		manifestPath = await realpath(join(packageRoot, SKIN_MANIFEST_FILE));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return invalidSkin(id, revision, `missing ${SKIN_MANIFEST_FILE}`);
		}
		throw error;
	}
	if (!pathIsInside(packageRoot, manifestPath)) {
		return invalidSkin(id, revision, `${SKIN_MANIFEST_FILE} escapes its package through a symbolic link`);
	}
	let handle: FileHandle;
	try {
		const safetyFlags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
		handle = await open(manifestPath, constants.O_RDONLY | safetyFlags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return invalidSkin(id, revision, `missing ${SKIN_MANIFEST_FILE}`);
		}
		throw error;
	}
	let source: string;
	try {
		const manifestInfo = await handle.stat();
		if (!manifestInfo.isFile()) return invalidSkin(id, revision, `${SKIN_MANIFEST_FILE} is not a file`);
		if (manifestInfo.size > SKIN_MANIFEST_MAX_BYTES) {
			return invalidSkin(id, revision, `${SKIN_MANIFEST_FILE} exceeds its size limit`);
		}
		const buffer = Buffer.alloc(SKIN_MANIFEST_READ_BYTES);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > SKIN_MANIFEST_MAX_BYTES) {
			return invalidSkin(id, revision, `${SKIN_MANIFEST_FILE} exceeds its size limit`);
		}
		source = buffer.subarray(0, offset).toString("utf8");
	} finally {
		await handle.close();
	}
	let raw: unknown;
	try {
		raw = JSON.parse(source) as unknown;
	} catch (error) {
		return invalidSkin(id, revision, toError(error).message);
	}
	const parsed = validationMessage(raw);
	if (parsed.manifest === null) return invalidSkin(id, revision, parsed.error ?? "Invalid skin manifest");
	if (parsed.manifest.id !== id) return invalidSkin(id, revision, `manifest id must match package directory ${id}`);
	const assetError = await validateManifestAssets(id, parsed.manifest);
	if (assetError !== null) return invalidSkin(id, revision, assetError);
	return { id, revision, manifest: parsed.manifest, error: null };
}

export async function listUserSkins(revisions: ReadonlyMap<string, number>): Promise<UserSkinsSnapshot> {
	await ensureSkinsDirectory();
	const directoryEntries = await readdir(SKINS_DIR, { withFileTypes: true });
	const packageEntries = directoryEntries
		// Include symbolic links so an unsafe or broken package is reported instead of silently disappearing.
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.sort((left, right) => left.name.localeCompare(right.name));
	const entries = packageEntries.slice(0, SKIN_PACKAGE_MAX_COUNT);
	const directoryIssues: string[] = [];
	if (packageEntries.length > SKIN_PACKAGE_MAX_COUNT) {
		directoryIssues.push(`only the first ${String(SKIN_PACKAGE_MAX_COUNT)} skin packages are loaded`);
	}
	const skins: UserSkinSnapshot[] = [];
	for (const entry of entries) {
		const revision = revisions.get(entry.name) ?? 0;
		if (!SKIN_ID_PATTERN.test(entry.name)) {
			skins.push(invalidSkin(entry.name, revision, "package directory must be a lowercase kebab-case skin id"));
			continue;
		}
		try {
			skins.push(await readSkinPackage(entry.name, revision));
		} catch (error) {
			skins.push(invalidSkin(entry.name, revision, toError(error).message));
		}
	}
	return { dir: SKINS_DIR, skins, error: directoryIssues.length === 0 ? null : directoryIssues.join("; ") };
}

export async function deleteSkinPackage(id: string): Promise<void> {
	if (!SKIN_ID_PATTERN.test(id)) throw new Error("Invalid skin id");
	await rm(join(SKINS_DIR, id), { recursive: true, force: true });
}
