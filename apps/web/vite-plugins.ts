import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import type { Plugin, PluginOption } from "vite";

const require = createRequire(import.meta.url);
const materialIconSource = resolve(dirname(require.resolve("material-icon-theme/package.json")), "icons");
const materialIconOverrides = new Set(["folder.svg", "tsdoc.svg"]);
const materialIconOmissions = new Set(["file.svg", "folder-open.svg", "folder-root.svg", "folder-root-open.svg"]);

export const PRODUCTION_BUILD = {
	minify: "esbuild",
	sourcemap: false,
} as const;

/** Keep the blocking first-paint script, but change its URL whenever its contents change.
 * This also bypasses immutable copies cached by older Host versions. */
function themeBootstrapVersionPlugin(): Plugin {
	return {
		name: "ling-theme-bootstrap-version",
		async transformIndexHtml(html) {
			const source = await readFile(resolve(import.meta.dirname, "public/theme-init.js"));
			const version = createHash("sha256").update(source).digest("hex");
			return html.replace('src="/theme-init.js"', `src="/theme-init.js?v=${version}"`);
		},
	};
}

function isBundledMaterialIcon(filename: string): boolean {
	return (
		filename.endsWith(".svg") &&
		!filename.endsWith(".clone.svg") &&
		!materialIconOverrides.has(filename) &&
		!materialIconOmissions.has(filename)
	);
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readMaterialIcon(requestUrl: string): Promise<Buffer | null> {
	const pathname = new URL(requestUrl, "http://ling.local").pathname;
	const filename = decodeURIComponent(pathname).replace(/^\/+/, "");
	if (!/^[a-z0-9_.-]+\.svg$/iu.test(filename) || !isBundledMaterialIcon(filename)) return null;
	try {
		return await readFile(resolve(materialIconSource, filename));
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
}

async function copyMaterialIcons(outputDirectory: string): Promise<void> {
	const filenames = (await readdir(materialIconSource)).filter(isBundledMaterialIcon);
	const destination = resolve(outputDirectory, "material-icons");
	await mkdir(destination, { recursive: true });
	await Promise.all(
		filenames.map((filename) => copyFile(resolve(materialIconSource, filename), resolve(destination, filename))),
	);
}

function materialIconAssetsPlugin(): Plugin {
	return {
		name: "ling-material-icon-assets",
		configureServer(server) {
			server.middlewares.use("/material-icons", (request, response, next) => {
				if (request.url === undefined) {
					next(new Error("Material icon request URL is required"));
					return;
				}
				void readMaterialIcon(request.url).then(
					(contents) => {
						if (contents === null) {
							next();
							return;
						}
						response.statusCode = 200;
						response.setHeader("Content-Type", "image/svg+xml");
						response.end(contents);
					},
					(error: unknown) => {
						next(error instanceof Error ? error : new Error("Material icon read failed", { cause: error }));
					},
				);
			});
		},
		async writeBundle(outputOptions) {
			if (!outputOptions.dir) throw new Error("Renderer build output directory is required");
			await copyMaterialIcons(outputOptions.dir);
		},
	};
}

export function rendererPlugins(): PluginOption[] {
	return [react(), svgr(), tailwindcss(), materialIconAssetsPlugin(), themeBootstrapVersionPlugin()];
}
