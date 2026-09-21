import { resolve } from "node:path";
import { defineConfig } from "vite";
import releasePackage from "../../package.json";

const hostRoot = import.meta.dirname;

export default defineConfig({
	define: {
		__LING_VERSION__: JSON.stringify(releasePackage.version),
	},
	resolve: {
		alias: {
			"@ling/node-runtime": resolve(hostRoot, "../node-runtime/src"),
			"@ling/core": resolve(hostRoot, "../core/src"),
			"@ling/host": resolve(hostRoot, "src"),
			"@ling/contracts": resolve(hostRoot, "../contracts/src"),
		},
	},
	ssr: {
		// Pi's extension loader derives runtime aliases from its installed package path.
		// Bundling it into Host assets makes those aliases point at the Host bundle instead.
		// Atomic publication uses its CommonJS filename to make collision-resistant temporary names.
		external: ["@earendil-works/pi-coding-agent", "write-file-atomic", "@typescript/native"],
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
			output: {
				entryFileNames: "[name].js",
			},
		},
	},
});
