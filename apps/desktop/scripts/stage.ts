import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const stageRoot = join(desktopRoot, ".stage");
const hostBuild = join(repositoryRoot, "packages/host/dist/index.js");
const webBuild = join(repositoryRoot, "apps/web/dist/index.html");
const appIcon = join(repositoryRoot, "resources/icon.png");

/** Node release used by Host and its workers. Native Pi dependencies and user-installed addons need this Node ABI. Update the version and SHASUMS256.txt checksums together for Node security releases. */
const HOST_NODE_VERSION = "24.21.0";
const HOST_NODE_ARCHIVES: Record<string, { archive: string; sha256: string }> = {
	"darwin-arm64": {
		archive: "darwin-arm64.tar.gz",
		sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
	},
	"darwin-x64": {
		archive: "darwin-x64.tar.gz",
		sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
	},
	"linux-arm64": {
		archive: "linux-arm64.tar.gz",
		sha256: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
	},
	"linux-x64": {
		archive: "linux-x64.tar.gz",
		sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
	},
	"win32-arm64": {
		archive: "win-arm64.zip",
		sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
	},
	"win32-x64": { archive: "win-x64.zip", sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541" },
};
/** Survives restaging; a cached archive is used only while its checksum still matches. */
const nodeArchiveCache = join(repositoryRoot, "node_modules/.cache/ling-host-node");

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function hostNodeArchive(archive: string, expected: string): Promise<string> {
	const cached = join(nodeArchiveCache, archive);
	if (existsSync(cached) && sha256(readFileSync(cached)) === expected) return cached;
	const url = `https://nodejs.org/dist/v${HOST_NODE_VERSION}/${archive}`;
	let bytes: Buffer;
	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		bytes = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw new Error(`Could not download ${url}. Save it as ${cached} to stage offline.`, { cause: error });
	}
	const actual = sha256(bytes);
	if (actual !== expected) throw new Error(`${url} has checksum ${actual}, expected ${expected}`);
	mkdirSync(nodeArchiveCache, { recursive: true });
	const partial = `${cached}.${process.pid}.partial`;
	writeFileSync(partial, bytes);
	renameSync(partial, cached);
	return cached;
}

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", windowsHide: true });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

/** Stages the pinned Node executable and its licence for the current platform and architecture. */
async function stageHostNode(runtimeStage: string): Promise<void> {
	const target = `${process.platform}-${process.arch}`;
	const release = HOST_NODE_ARCHIVES[target];
	if (!release) throw new Error(`No pinned Node ${HOST_NODE_VERSION} archive for ${target}`);
	const archiveName = `node-v${HOST_NODE_VERSION}-${release.archive}`;
	const archive = await hostNodeArchive(archiveName, release.sha256);
	const root = archiveName.replace(/\.(tar\.gz|zip)$/, "");
	const executableName = process.platform === "win32" ? "node.exe" : "node";
	const executableMember = process.platform === "win32" ? `${root}/node.exe` : `${root}/bin/node`;
	const licenseMember = `${root}/LICENSE`;
	// Use Windows' bsdtar for ZIP support; Git or MSYS tar may appear earlier on PATH.
	const tar =
		process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	const extracted = mkdtempSync(join(stageRoot, "node-"));
	try {
		run(tar, ["-xf", archive, "-C", extracted, executableMember, licenseMember]);
		mkdirSync(runtimeStage, { recursive: true });
		renameSync(join(extracted, executableMember), join(runtimeStage, executableName));
		renameSync(join(extracted, licenseMember), join(runtimeStage, "LICENSE.node.txt"));
	} finally {
		rmSync(extracted, { recursive: true, force: true });
	}
	const probe = run(join(runtimeStage, executableName), [
		"-p",
		"JSON.stringify([process.versions.node, process.platform, process.arch])",
	]);
	const expected = JSON.stringify([HOST_NODE_VERSION, process.platform, process.arch]);
	if (probe.trim() !== expected) throw new Error(`Staged Node reports ${probe.trim()}, expected ${expected}`);
	console.log(`Staged Node ${HOST_NODE_VERSION} for ${target}`);
}

for (const required of [hostBuild, webBuild, appIcon]) {
	if (!existsSync(required)) throw new Error(`Required Ling build output is missing: ${required}`);
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

cpSync(join(repositoryRoot, "apps/web/dist"), join(stageRoot, "web"), { recursive: true });
cpSync(join(repositoryRoot, "builtin-skills"), join(stageRoot, "builtin-skills"), { recursive: true });
cpSync(appIcon, join(stageRoot, "icon.png"));
await stageHostNode(join(stageRoot, "runtime"));
