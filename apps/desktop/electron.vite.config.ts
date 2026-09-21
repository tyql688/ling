import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import releasePackage from "../../package.json";

const PRODUCTION_BUILD = {
	minify: "esbuild",
	sourcemap: false,
} as const;

// Web owns the renderer build. Desktop commands suppress electron-vite's optional-target warning.
export default defineConfig({
	main: {
		define: {
			__LING_VERSION__: JSON.stringify(releasePackage.version),
		},
		build: {
			...PRODUCTION_BUILD,
			externalizeDeps: { exclude: ["@ling/contracts", "@ling/node-runtime", "zod"] },
			rollupOptions: { input: { index: resolve("src/main.ts") } },
		},
	},
	preload: {
		build: {
			...PRODUCTION_BUILD,
			externalizeDeps: { exclude: ["@ling/contracts", "zod"] },
			rollupOptions: {
				input: { index: resolve("src/preload.ts") },
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
});
