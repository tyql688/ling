import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/** Pi's bundle; the packages it still imports by name are read from its files. */
const PI_SDK_BUNDLE_DIRECTORY = "dist/bundle";

/**
 * Inside the SDK package only the bundle, the assets its `dist/config.js` getters read (themes,
 * interactive assets, HTML export template) and the documents Pi serves remain.
 */
const PI_SDK_REQUIRED_PATHS = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"docs",
	"examples",
	PI_SDK_BUNDLE_DIRECTORY,
	"dist/modes/interactive/theme",
	"dist/modes/interactive/assets",
	"dist/core/export-html",
];

/** Written beside the SDK bundle for the packages the staged tree no longer ships. */
const BUNDLED_NOTICES_FILE = "BUNDLED_DEPENDENCY_NOTICES.md";

/** Present in some SDK releases only. */
const PI_SDK_OPTIONAL_PATHS = ["LICENSE", "LICENSE.md", "node_modules", BUNDLED_NOTICES_FILE];

const REMOVED_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__", "man"]);
const SOURCE_ONLY_EXTENSIONS = new Set([".map", ".c", ".h", ".cc", ".cpp", ".gyp"]);
const BUILTINS = new Set(builtinModules);

/**
 * Pi 0.99.2's provider bundles guard these optional integrations at their call sites. Every other
 * literal external import must resolve. Reaudit this list with the SDK bundle on a Pi upgrade.
 */
const OPTIONAL_BUNDLE_IMPORTS = new Set(["supports-color", "kerberos", "bufferutil", "utf-8-validate"]);

/** SDK 0.99.2 supplies these peers to Pi extension factories through its virtual module registry. */
const PI_VIRTUAL_PEERS = new Set([
	"typebox",
	"@sinclair/typebox",
	...["@earendil-works", "@mariozechner"].flatMap((scope) =>
		["pi-agent-core", "pi-ai", "pi-tui", "pi-coding-agent"].map((name) => `${scope}/${name}`),
	),
]);

interface PruneOptions {
	hostRoot: string;
	platform: NodeJS.Platform;
	arch: string;
}

interface PackageManifest {
	version?: string;
	license?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	pi?: unknown;
}

/**
 * Programs the Host executes and whose whole tree is their runtime: the npm CLI (node-gyp compiles
 * shipped C sources on Windows), the TypeScript 7 binary (reads `lib/*.d.ts`) and the SDK's curated
 * tree, whose documents and examples Pi serves.
 */
function shipsVerbatim(name: string): boolean {
	return name === "npm" || name.startsWith("@typescript/") || name === PI_SDK_PACKAGE;
}

/** Package names imported by the bundle; built-ins and relative paths are not dependency edges. */
async function readBundleDependencies(directory: string): Promise<Set<string>> {
	const dependencies = new Set<string>();
	for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
		if (entry.isDirectory() || extname(entry.name) !== ".js") continue;
		const path = join(entry.parentPath, entry.name);
		const source = await readFile(path, "utf8");
		const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
		const visit = (node: ts.Node): void => {
			let argument: ts.Node | undefined;
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier;
			// esbuild gives its CommonJS require shims numbered names. Parsing syntax avoids matching
			// documentation, string contents and comments as executable dependency edges.
			if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && /^(?:__)?require\d*$/.test(node.expression.text)) ||
					// File-backed runtime assets are resolved without importing their package.
					(ts.isPropertyAccessExpression(node.expression) &&
						node.expression.name.text === "resolve" &&
						((ts.isIdentifier(node.expression.expression) &&
							/^(?:__)?require\d*$/.test(node.expression.expression.text)) ||
							(ts.isCallExpression(node.expression.expression) &&
								ts.isIdentifier(node.expression.expression.expression) &&
								/^createRequire\d*$/.test(node.expression.expression.expression.text)))))
			)
				argument = node.arguments[0];
			if (argument && ts.isStringLiteralLike(argument) && !BUILTINS.has(argument.text)) {
				const name = /^(?:@[\w.-]+\/)?[\w-][\w.-]*(?=\/|$)/.exec(argument.text)?.[0];
				if (name) dependencies.add(name);
			}
			ts.forEachChild(node, visit);
		};
		visit(syntax);
	}
	return dependencies;
}

/** A directory without a manifest is not a package; a malformed manifest is a broken deploy. */
async function readManifest(directory: string): Promise<PackageManifest | null> {
	const path = join(directory, "package.json");
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		return JSON.parse(source) as PackageManifest;
	} catch (error) {
		throw new Error(`Malformed package manifest ${path}`, { cause: error });
	}
}

interface InstalledPackage {
	directory: string;
	name: string;
	manifest: PackageManifest;
}

async function installedPackages(nodeModules: string): Promise<Map<string, InstalledPackage>> {
	const packages = new Map<string, InstalledPackage>();
	const visit = async (directory: string, scope = ""): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!scope && entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Expected a standalone hoisted deploy: ${path}`);
			if (!entry.isDirectory()) continue;
			if (!scope && entry.name.startsWith("@")) {
				await visit(path, `${entry.name}/`);
				continue;
			}
			const manifest = await readManifest(path);
			if (manifest === null) continue;
			packages.set(path, { directory: path, name: scope + entry.name, manifest });
			if (existsSync(join(path, "node_modules"))) await visit(join(path, "node_modules"));
		}
	};
	await visit(nodeModules);
	return packages;
}

/**
 * Resolve every edge from its installed importer, just as Node walks ancestor node_modules.
 * Package names alone are insufficient: extensions can carry different nested dependency versions.
 * Only Pi extension peers supplied by the SDK are virtual; ordinary peers remain runtime edges.
 */
function reachablePackages(
	hostRoot: string,
	packages: Map<string, InstalledPackage>,
	roots: readonly string[],
	bundleDependencies: ReadonlySet<string>,
): Set<string> {
	const kept = new Set<string>();
	const queue: InstalledPackage[] = [];
	const requirePackage = (importer: string, name: string, optional = false): void => {
		for (let directory = importer; ; directory = dirname(directory)) {
			const dependency = packages.get(join(directory, "node_modules", name));
			if (dependency) {
				queue.push(dependency);
				return;
			}
			if (directory === hostRoot) break;
		}
		if (!optional)
			throw new Error(`Required dependency ${name} is not deployed for ${relative(hostRoot, importer) || "Host"}`);
	};
	for (const name of roots) requirePackage(hostRoot, name);
	while (queue.length > 0) {
		const pkg = queue.pop()!;
		const { directory, manifest } = pkg;
		if (kept.has(directory)) continue;
		kept.add(directory);
		if (pkg.name === PI_SDK_PACKAGE) {
			for (const name of bundleDependencies) requirePackage(directory, name, OPTIONAL_BUNDLE_IMPORTS.has(name));
			continue;
		}
		for (const name of Object.keys(manifest.dependencies ?? {}))
			requirePackage(directory, name, name in (manifest.optionalDependencies ?? {}));
		for (const name of Object.keys(manifest.optionalDependencies ?? {})) requirePackage(directory, name, true);
		for (const name of Object.keys(manifest.peerDependencies ?? {})) {
			if (manifest.pi !== undefined && PI_VIRTUAL_PEERS.has(name)) continue;
			requirePackage(directory, name, manifest.peerDependenciesMeta?.[name]?.optional === true);
		}
		// npm includes its own bundled tooling. Preserve its complete subtree, including packages
		// used indirectly by node-gyp and npm exec, and still follow edges out of that subtree.
		if (shipsVerbatim(pkg.name))
			for (const child of packages.values())
				if (child.directory.startsWith(`${directory}${sep}node_modules${sep}`)) queue.push(child);
	}
	return kept;
}

/** Removes every entry under `root` that is neither a kept path nor an ancestor or descendant of one. */
async function keepOnly(root: string, keptPaths: readonly string[]): Promise<void> {
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const rel = relative(root, path).split(sep).join("/");
			if (keptPaths.includes(rel)) continue;
			if (keptPaths.some((kept) => kept.startsWith(`${rel}/`))) {
				await walk(path);
				continue;
			}
			await rm(path, { recursive: true, force: true });
		}
	};
	await walk(root);
}

function isLicenseFile(name: string): boolean {
	return /licen[cs]e|copying|notice/i.test(name);
}

function isSourceOnlyFile(name: string, keepsMarkdown: boolean): boolean {
	if (isLicenseFile(name)) return false;
	if (/\.d\.[cm]?ts$/.test(name) || SOURCE_ONLY_EXTENSIONS.has(extname(name))) return true;
	return !keepsMarkdown && (/\.(md|markdown)$/i.test(name) || /^CHANGELOG/i.test(name));
}

/** Deletes development-only files and other platforms' prebuilt binaries from every package. */
async function removeSourceOnlyFiles(packages: InstalledPackage[], target: string): Promise<void> {
	const verbatim = packages.filter((pkg) => shipsVerbatim(pkg.name)).map((pkg) => pkg.directory);
	const walk = async (directory: string, keepsMarkdown: boolean): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			// Each installed dependency has its own retention policy.
			if (entry.isDirectory() && entry.name === "node_modules") continue;
			// prebuildify layouts name one directory per exact `<platform>-<arch>` target.
			const remove = entry.isDirectory()
				? REMOVED_DIRECTORY_NAMES.has(entry.name) || (basename(directory) === "prebuilds" && entry.name !== target)
				: entry.isFile() && isSourceOnlyFile(entry.name, keepsMarkdown);
			if (remove) await rm(path, { recursive: true, force: true });
			else if (entry.isDirectory()) await walk(path, keepsMarkdown);
		}
	};
	for (const pkg of packages) {
		if (verbatim.some((directory) => pkg.directory === directory || pkg.directory.startsWith(`${directory}${sep}`)))
			continue;
		await walk(pkg.directory, pkg.manifest.pi !== undefined);
	}
}

/** Keep esbuild's CLI path while sharing its identical, platform-specific executable on Unix. */
async function linkEsbuildExecutables(hostRoot: string, packages: InstalledPackage[], target: string): Promise<void> {
	const binaries = new Set(packages.filter((pkg) => pkg.name === `@esbuild/${target}`).map((pkg) => pkg.directory));
	for (const pkg of packages) {
		if (pkg.name !== "esbuild") continue;
		for (let directory = pkg.directory; ; directory = dirname(directory)) {
			const binaryPackage = join(directory, "node_modules", `@esbuild/${target}`);
			if (binaries.has(binaryPackage)) {
				const executable = join(binaryPackage, "bin/esbuild");
				const cli = join(pkg.directory, "bin/esbuild");
				const [cliBytes, executableBytes] = await Promise.all([readFile(cli), readFile(executable)]);
				// The published JavaScript launcher and custom binaries keep their own contents.
				if (cliBytes.equals(executableBytes)) {
					await rm(cli);
					await symlink(relative(dirname(cli), executable), cli);
				}
				break;
			}
			if (directory === hostRoot) break;
		}
	}
}

/**
 * Only the npm and npx shims stay in `.bin`: they put the pinned npm on toolchain PATHs. Toolchain
 * children see this directory first, so any other entry would shadow the user's own tools.
 */
async function keepNpmBinLinks(binDirectory: string): Promise<void> {
	if (!existsSync(binDirectory)) return;
	for (const entry of await readdir(binDirectory)) {
		if (/^np[mx](\.cmd|\.ps1)?$/.test(entry)) continue;
		await rm(join(binDirectory, entry), { recursive: true, force: true });
	}
}

/**
 * Licence texts of the packages the staged tree drops: the SDK bundle embeds most of them, the rest
 * are not shipped. Versions are those pnpm resolved for this deploy.
 */
async function bundledDependencyNotices(packages: readonly InstalledPackage[]): Promise<string> {
	const sections: string[] = [];
	for (const { name, directory, manifest } of packages) {
		if (name.startsWith("@ling/")) continue;
		const texts: string[] = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isFile() && isLicenseFile(entry.name))
				texts.push((await readFile(join(directory, entry.name), "utf8")).trim());
		}
		sections.push(
			[`## ${name}@${manifest.version ?? "unknown"}`, `License: ${manifest.license ?? "see text"}`, ...texts].join(
				"\n\n",
			),
		);
	}
	return `# Packages removed from the staged Host tree\n\nThe Pi SDK bundle embeds most of these packages; the others are not shipped. Their licence texts follow.\n\n${sections.join("\n\n")}\n`;
}

/**
 * Reduces a deployed Host tree to what runs from disk: every dependency the Host declares, the
 * packages the SDK bundle imports by name, and their installed dependency closures.
 * The SDK package keeps its bundle, assets, documents and any required nested dependencies.
 */
export async function pruneStagedHost(options: PruneOptions) {
	const hostRoot = resolve(options.hostRoot);
	const nodeModules = join(hostRoot, "node_modules");
	const sdkRoot = join(nodeModules, PI_SDK_PACKAGE);
	const bundleRoot = join(sdkRoot, PI_SDK_BUNDLE_DIRECTORY);
	if (!existsSync(join(bundleRoot, "index.js"))) throw new Error(`Pi SDK bundle is missing under ${sdkRoot}`);
	const hostManifest = await readManifest(hostRoot);
	if (hostManifest === null) throw new Error(`Host manifest is missing under ${hostRoot}`);
	const declared = Object.keys(hostManifest.dependencies ?? {}).filter((name) => !name.startsWith("@ling/"));
	const bundleDependencies = await readBundleDependencies(bundleRoot);
	const packages = await installedPackages(nodeModules);
	const kept = reachablePackages(hostRoot, packages, declared, bundleDependencies);
	for (const path of PI_SDK_REQUIRED_PATHS) {
		if (!existsSync(join(sdkRoot, path)))
			throw new Error(`${PI_SDK_PACKAGE} no longer ships ${path}; update the kept paths`);
	}
	const removed = [...packages.values()].filter((pkg) => !kept.has(pkg.directory));
	const notices = removed.length === 0 ? null : await bundledDependencyNotices(removed);
	for (const pkg of removed) await rm(pkg.directory, { recursive: true, force: true });
	await keepNpmBinLinks(join(nodeModules, ".bin"));
	await keepOnly(sdkRoot, [...PI_SDK_REQUIRED_PATHS, ...PI_SDK_OPTIONAL_PATHS]);
	if (notices !== null) await writeFile(join(sdkRoot, BUNDLED_NOTICES_FILE), notices);
	const retained = [...packages.values()].filter((pkg) => kept.has(pkg.directory));
	const target = `${options.platform}-${options.arch}`;
	await removeSourceOnlyFiles(retained, target);
	// Windows must not require developer mode or elevation to create file symlinks.
	if (options.platform !== "win32") await linkEsbuildExecutables(hostRoot, retained, target);
	return {
		keptPackages: kept.size,
		removedPackages: removed.length,
	};
}

if (import.meta.main) {
	const hostRoot = resolve(import.meta.dirname, "../.stage/host");
	const summary = await pruneStagedHost({ hostRoot, platform: process.platform, arch: process.arch });
	console.log(`Pruned staged Host: kept ${summary.keptPackages} packages, removed ${summary.removedPackages} packages`);
}
