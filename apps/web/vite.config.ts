import { resolve } from "node:path";
import { defineConfig } from "vite";
import { PRODUCTION_BUILD, rendererPlugins } from "./vite-plugins";

const webRoot = import.meta.dirname;

export default defineConfig({
	root: webRoot,
	plugins: rendererPlugins(),
	worker: { format: "es" },
	resolve: {
		alias: [
			{ find: "@renderer", replacement: resolve(webRoot, "src") },
			{ find: "@ling/contracts", replacement: resolve(webRoot, "../../packages/contracts/src") },
			{ find: /^shiki$/, replacement: resolve(webRoot, "src/lib/code-highlighting/shiki-bundle.ts") },
		],
	},
	build: {
		...PRODUCTION_BUILD,
		outDir: resolve(webRoot, "dist"),
		emptyOutDir: true,
		rollupOptions: {
			input: { index: resolve(webRoot, "index.html") },
		},
	},
});
