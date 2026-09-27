import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import releasePackage from "../../package.json";

const hostRoot = import.meta.dirname;

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Pi's bundle: the SDK, its sibling packages and the provider SDKs in one directory, built with
 * `isBundledNode` set so the extension loader serves `@earendil-works/*` and `typebox` to
 * extensions from embedded virtual modules. The Host imports this entry through a path relative
 * to its own `dist/`.
 */
const PI_SDK_BUNDLE_ENTRY = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js";

/** Resolves the SDK specifier to its bundle entry and keeps it external for a `dist`-relative import. */
function piSdkBundle(): Plugin {
	const entry = resolve(hostRoot, PI_SDK_BUNDLE_ENTRY);
	// Rollup never checks external ids; a missing bundle must fail the build, not the packaged Host.
	if (!existsSync(entry)) throw new Error(`Pi SDK bundle entry is missing: ${entry}`);
	return {
		name: "ling-pi-sdk-bundle",
		enforce: "pre",
		resolveId(source) {
			return source === PI_SDK_PACKAGE ? { id: entry, external: true } : null;
		},
	};
}

export default defineConfig({
	define: {
		__LING_VERSION__: JSON.stringify(releasePackage.version),
	},
	plugins: [piSdkBundle()],
	resolve: {
		alias: {
			"@ling/node-runtime": resolve(hostRoot, "../node-runtime/src"),
			"@ling/core": resolve(hostRoot, "../core/src"),
			"@ling/host": resolve(hostRoot, "src"),
			"@ling/contracts": resolve(hostRoot, "../contracts/src"),
		},
	},
	ssr: {
		// pi-mcp-adapter stays a real package because Pi loads its extension entry from disk.
		// Atomic publication uses write-file-atomic's CommonJS filename for collision-resistant temporary names.
		// Jiti resolves its compiler relative to its installed entry file.
		external: ["pi-mcp-adapter", "write-file-atomic", "@typescript/native", "jiti"],
	},
	build: {
		target: "node22",
		outDir: resolve(hostRoot, "dist"),
		emptyOutDir: true,
		minify: "esbuild",
		sourcemap: false,
		ssr: true,
		rollupOptions: {
			input: {
				index: resolve(hostRoot, "src/index.ts"),
				"pi-worker-entry": resolve(hostRoot, "src/workers/pi/entry.ts"),
				"plugin-host-entry": resolve(hostRoot, "src/workers/plugin/entry.ts"),
				"terminal-host-entry": resolve(hostRoot, "src/workers/terminal/entry.ts"),
				"usage-host-entry": resolve(hostRoot, "src/workers/usage/entry.ts"),
			},
			// Rollup relativizes the SDK's absolute id per chunk against the entries' common
			// directory (`src/`), so `dist/` and `dist/assets/` chunks import `../node_modules/...`
			// at the right depth as long as every entry lives under `src/`.
			makeAbsoluteExternalsRelative: true,
			output: {
				entryFileNames: "[name].js",
			},
		},
	},
});
