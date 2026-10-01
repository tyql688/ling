import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { temporaryDirectory } from "../../../test/temporary-directory";
import { pruneStagedHost } from "./prune-host";

let hostRoot: string | null = null;

afterEach(async () => {
	if (hostRoot) await rm(hostRoot, { recursive: true, force: true });
	hostRoot = null;
});

async function write(path: string, content = ""): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

const SDK = "@earendil-works/pi-coding-agent";

async function fixture(): Promise<string> {
	const root = await temporaryDirectory("prune-host");
	hostRoot = root;
	const modules = join(root, "node_modules");
	const pkg = (name: string, manifest: object) =>
		write(join(modules, name, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
	await write(
		join(root, "package.json"),
		JSON.stringify({
			name: "@ling/host",
			dependencies: {
				[SDK]: "1",
				"@ling/core": "workspace:*",
				"fixture-extension": "1",
				ws: "1",
				"node-pty": "1",
				npm: "1",
			},
		}),
	);
	await write(join(root, "dist/index.js"), 'import"ws";');
	await pkg(SDK, { dependencies: { openai: "1", typebox: "1" } });
	await write(
		join(modules, SDK, "dist/bundle/chunks/a.js"),
		'import"typebox";import{withCancel}from"@earendil-works/chord/context";await import("@silvia-odwyer/photon-node");require2("jiti");',
	);
	for (const file of [
		"dist/index.js",
		"dist/config.js",
		"dist/bundle/index.js",
		"dist/modes/interactive/theme/dark.json",
		"dist/modes/interactive/assets/logo.png",
		"dist/core/export-html/template.html",
		"docs/README.md",
		"examples/extensions/overlay/native.c",
		"README.md",
		"CHANGELOG.md",
	])
		await write(join(modules, SDK, file));
	await pkg("openai", { license: "Apache-2.0" });
	await write(join(modules, "openai/LICENSE"), "Apache License 2.0 text");
	await write(join(modules, "openai/NOTICE"), "Notice text");
	await write(join(modules, "zod/THIRD_PARTY_LICENSES.md"), "third-party");
	await pkg("typebox", {});
	await pkg("@earendil-works/chord", { dependencies: { esbuild: "1" } });
	await pkg("esbuild", {});
	await pkg("@silvia-odwyer/photon-node", {});
	await pkg("jiti", {});
	await pkg("fixture-extension", {
		pi: { extensions: ["index.ts"] },
		dependencies: { zod: "1", recheck: "1", undici: "1" },
		peerDependencies: { "@earendil-works/pi-ai": "*", typebox: "*", "runtime-peer": "1" },
	});
	await write(join(modules, "fixture-extension/index.ts"));
	await write(join(modules, "fixture-extension/docs/usage.md"));
	await pkg("fixture-extension/node_modules/undici", { dependencies: { "fast-uri": "1" } });
	await pkg("fixture-extension/node_modules/typebox", {});
	await pkg("undici", { dependencies: { "unreachable-child": "1" } });
	await pkg("unreachable-child", {});
	await pkg("runtime-peer", {});
	await pkg("fast-uri", {});
	await write(join(modules, "fast-uri/LICENSE.md"), "MIT");
	await pkg("recheck", { optionalDependencies: { "recheck-jar": "1", "recheck-macos-arm64": "1" } });
	await pkg("recheck-jar", {});
	await pkg("recheck-macos-arm64", {});
	await pkg("@earendil-works/pi-ai", {});
	await pkg("zod", {});
	await write(join(modules, "zod/index.js"));
	await write(join(modules, "zod/index.d.ts"));
	await write(join(modules, "zod/README.md"));
	await write(join(modules, "zod/test/index.test.js"));
	await pkg("ws", { optionalDependencies: { "utf-8-validate": "1" } });
	await write(join(modules, "ws/index.js"));
	await write(join(modules, "ws/index.js.map"));
	await pkg("node-pty", {});
	await write(join(modules, "node-pty/prebuilds/darwin-arm64/pty.node"));
	await write(join(modules, "node-pty/prebuilds/linux-x64/pty.node"));
	await write(join(modules, "node-pty/binding.gyp"));
	await pkg("@ling/core", {});
	await write(join(modules, "@ling/core/src/index.ts"));
	await pkg("npm", {});
	await write(join(modules, "npm/bin/npm-cli.js"));
	await write(join(modules, "npm/bin/npx-cli.js"));
	await write(join(modules, "npm/node_modules/node-gyp/src/win_delay_load_hook.cc"));
	await pkg("@typescript/native", { optionalDependencies: { "@typescript/typescript-darwin-arm64": "1" } });
	await pkg("@typescript/typescript-darwin-arm64", {});
	await write(join(modules, "@typescript/typescript-darwin-arm64/lib/lib.d.ts"));
	await mkdir(join(modules, ".bin"), { recursive: true });
	await symlink("../npm/bin/npm-cli.js", join(modules, ".bin/npm"));
	await symlink("../openai/bin/cli.js", join(modules, ".bin/openai"));
	await symlink("../zod/bin/zod.js", join(modules, ".bin/zod"));
	await symlink("../npm/bin/npx-cli.js", join(modules, ".bin/npx"));
	return root;
}

it("shares identical Unix esbuild executables and preserves distinct launchers", async () => {
	const root = await fixture();
	const modules = join(root, "node_modules");
	const cli = join(modules, "esbuild/bin/esbuild");
	const native = join(modules, "@esbuild/darwin-arm64/bin/esbuild");
	await write(
		join(modules, "esbuild/package.json"),
		JSON.stringify({ dependencies: { "@esbuild/darwin-arm64": "1" } }),
	);
	await write(join(modules, "@esbuild/darwin-arm64/package.json"), "{}");
	await write(cli, "native binary");
	await write(native, "native binary");
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
	expect(await readlink(cli)).toBe("../../@esbuild/darwin-arm64/bin/esbuild");
	expect(await readFile(cli, "utf8")).toBe("native binary");
	await rm(cli);
	await write(cli, "#!/usr/bin/env node\nrequire('../lib/main.js')");
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
	expect((await lstat(cli)).isSymbolicLink()).toBe(false);
	expect(await readFile(cli, "utf8")).toContain("require('../lib/main.js')");
});

it("keeps declared and bundle-imported packages with their closures and strips the SDK to its bundle", async () => {
	const root = await fixture();
	const modules = join(root, "node_modules");
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });

	for (const removed of [
		"@earendil-works/pi-ai",
		"@ling/core",
		"@typescript/native",
		"@typescript/typescript-darwin-arm64",
		"openai",
		"undici",
		"unreachable-child",
		"fixture-extension/node_modules/typebox",
	])
		expect(existsSync(join(modules, removed)), removed).toBe(false);
	for (const kept of [
		"@earendil-works/chord",
		SDK,
		"@silvia-odwyer/photon-node",
		"fast-uri",
		"esbuild",
		"jiti",
		"node-pty",
		"npm",
		"fixture-extension",
		"fixture-extension/node_modules/undici",
		"runtime-peer",
		"recheck",
		"recheck-jar",
		"recheck-macos-arm64",
		"typebox",
		"ws",
		"zod",
	])
		expect(existsSync(join(modules, kept, "package.json")), kept).toBe(true);
	expect(existsSync(join(modules, ".bin/npm"))).toBe(true);
	expect(existsSync(join(modules, ".bin/npx"))).toBe(true);
	expect(existsSync(join(modules, ".bin/openai"))).toBe(false);
	expect(existsSync(join(modules, ".bin/zod"))).toBe(false);

	const sdk = join(modules, SDK);
	for (const kept of [
		"package.json",
		"README.md",
		"dist/bundle/index.js",
		"dist/bundle/chunks/a.js",
		"dist/modes/interactive/theme/dark.json",
		"dist/core/export-html/template.html",
		"docs/README.md",
		"examples/extensions/overlay/native.c",
	])
		expect(existsSync(join(sdk, kept)), kept).toBe(true);
	for (const removed of ["dist/index.js", "dist/config.js"])
		expect(existsSync(join(sdk, removed)), removed).toBe(false);
	const notices = await readFile(join(sdk, "BUNDLED_DEPENDENCY_NOTICES.md"), "utf8");
	expect(notices).toContain("## openai@1.0.0");
	expect(notices).toContain("Apache License 2.0 text");
	expect(notices).toContain("Notice text");
	expect(existsSync(join(modules, "zod/THIRD_PARTY_LICENSES.md"))).toBe(true);
	expect(notices).not.toContain("@ling/core");

	expect(existsSync(join(modules, "fixture-extension/index.ts"))).toBe(true);
	expect(existsSync(join(modules, "fixture-extension/docs/usage.md"))).toBe(true);
	expect(existsSync(join(modules, "fast-uri/LICENSE.md"))).toBe(true);
	expect(existsSync(join(modules, "zod/index.js"))).toBe(true);
	expect(existsSync(join(modules, "zod/index.d.ts"))).toBe(false);
	expect(existsSync(join(modules, "zod/README.md"))).toBe(false);
	expect(existsSync(join(modules, "zod/test"))).toBe(false);
	expect(existsSync(join(modules, "node-pty/prebuilds/darwin-arm64/pty.node"))).toBe(true);
	expect(existsSync(join(modules, "node-pty/prebuilds/linux-x64"))).toBe(false);
	expect(existsSync(join(modules, "npm/node_modules/node-gyp/src/win_delay_load_hook.cc"))).toBe(true);
});

it("ships toolchain packages verbatim", async () => {
	const root = await fixture();
	const modules = join(root, "node_modules");
	await write(join(root, "package.json"), JSON.stringify({ dependencies: { [SDK]: "1", "@typescript/native": "1" } }));
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
	expect(existsSync(join(modules, "@typescript/typescript-darwin-arm64/lib/lib.d.ts"))).toBe(true);
});

it("rejects missing required dependencies before modifying the deploy", async () => {
	const root = await fixture();
	const modules = join(root, "node_modules");
	await rm(join(modules, "fast-uri"), { recursive: true });
	await expect(pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" })).rejects.toThrow(
		/Required dependency fast-uri .*fixture-extension/,
	);
	expect(existsSync(join(modules, "openai/LICENSE"))).toBe(true);
	await write(join(modules, "fast-uri/package.json"), "{}");
	await rm(join(modules, "ws"), { recursive: true });
	await expect(pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" })).rejects.toThrow(
		/Required dependency ws is not deployed/,
	);
	await rm(join(modules, SDK, "dist/bundle"), { recursive: true });
	await expect(pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" })).rejects.toThrow(
		/bundle is missing/,
	);
});

it("parses runtime imports without treating strings and comments as dependencies", async () => {
	const root = await fixture();
	await write(
		join(root, "node_modules", SDK, "dist/bundle/chunks/b.js"),
		'const example = `import "example-only"`; // require("comment-only")\nimport("bufferutil"); import "node:fs"; import "fs/promises";',
	);
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
});

it("fails on new missing bundle imports instead of silently omitting them", async () => {
	const root = await fixture();
	await write(join(root, "node_modules", SDK, "dist/bundle/chunks/b.js"), 'import("new-required-package");');
	await expect(pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" })).rejects.toThrow(
		/Required dependency new-required-package/,
	);
});

it("retains resolved WASM assets and rejects missing runtime asset packages", async () => {
	const root = await fixture();
	const modules = join(root, "node_modules");
	const script = join(modules, SDK, "dist/bundle/chunks/wasm.js");
	await write(
		script,
		'createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"); require2.resolve("asset-package/data.bin"); path.resolve("not-a-package");',
	);
	await write(join(modules, "quickjs-wasi/package.json"), "{}");
	await write(join(modules, "quickjs-wasi/quickjs.wasm"), "wasm fixture");
	await expect(pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" })).rejects.toThrow(
		/Required dependency asset-package/,
	);
	await write(join(modules, "asset-package/package.json"), "{}");
	await write(join(modules, "asset-package/data.bin"), "data");
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
	expect(existsSync(join(modules, "quickjs-wasi/quickjs.wasm"))).toBe(true);
	expect(existsSync(join(modules, "asset-package/data.bin"))).toBe(true);
});

it("retains the bundle's nested dependency and ordinary peers with their own closures", async () => {
	const root = await fixture();
	const modules = join(root, "node_modules");
	await write(
		join(modules, SDK, "node_modules/jiti/package.json"),
		JSON.stringify({ dependencies: { "nested-child": "1" } }),
	);
	await write(join(modules, "nested-child/package.json"), "{}");
	await write(
		join(modules, "runtime-peer/package.json"),
		JSON.stringify({ peerDependencies: { "@earendil-works/pi-ai": "*" } }),
	);
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
	expect(existsSync(join(modules, SDK, "node_modules/jiti/package.json"))).toBe(true);
	expect(existsSync(join(modules, "jiti"))).toBe(false);
	expect(existsSync(join(modules, "nested-child/package.json"))).toBe(true);
	expect(existsSync(join(modules, "@earendil-works/pi-ai/package.json"))).toBe(true);
});

it("keeps the notices file when run again", async () => {
	const root = await fixture();
	const notices = join(root, "node_modules", SDK, "BUNDLED_DEPENDENCY_NOTICES.md");
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
	const first = await readFile(notices, "utf8");
	await pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" });
	expect(await readFile(notices, "utf8")).toBe(first);
});

it("reports a malformed manifest by path", async () => {
	const root = await fixture();
	await writeFile(join(root, "node_modules/zod/package.json"), "{");
	await expect(pruneStagedHost({ hostRoot: root, platform: "darwin", arch: "arm64" })).rejects.toThrow(
		/Malformed package manifest .*zod/,
	);
});
