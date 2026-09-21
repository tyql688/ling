import { basenameFromPath } from "@renderer/lib/format-path";
import { useEffect, useState } from "react";

/** material-icons static asset directory (relative to renderer public). */
const MATERIAL_ICON_DIRECTORY = "./material-icons";
/** Default icon stem when neither filename nor extension matches. */
const DEFAULT_MATERIAL_ICON = "document";
/** Inline SVG data URL used when the asset fails to load, so a file shape still shows. */
const MATERIAL_ICON_FALLBACK =
	"data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M4.5%201.5h4.586L12.5%204.914V13a1.5%201.5%200%200%201-1.5%201.5h-6A1.5%201.5%200%200%201%203.5%2013V3A1.5%201.5%200%200%201%205%201.5Z%22%20stroke%3D%22%2394A3B8%22%20stroke-width%3D%221.2%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M9%201.75V5h3.25%22%20stroke%3D%22%2394A3B8%22%20stroke-width%3D%221.2%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E";

/**
 * Special filenames → icon stem (takes priority over extensions).
 * Aligned with the material-icon-theme contract; when adding/removing entries, keep the lookup order: filename → extension → default.
 */
const MATERIAL_ICON_FILE_NAMES: Readonly<Record<string, string>> = {
	".editorconfig": "editorconfig",
	".env": "settings",
	".gitattributes": "git",
	".gitignore": "git",
	".npmrc": "npm",
	".nvmrc": "nodejs_alt",
	".prettierignore": "prettier",
	".prettierrc": "prettier",
	".yarnrc": "yarn",
	"babel.config": "babel",
	bun: "lock",
	"bun.lock": "lock",
	cargo: "rust",
	"cargo.lock": "lock",
	dockerfile: "docker",
	eslint: "eslint",
	"eslint.config": "eslint",
	gemfile: "gemfile",
	jest: "jest",
	"jest.config": "jest",
	makefile: "makefile",
	"package-lock": "lock",
	"pnpm-lock": "lock",
	readme: "readme",
	tsconfig: "tsconfig",
	vitest: "vitest",
	"vitest.config": "vitest",
	yarn: "yarn",
};

/** Extension → icon stem; the second lookup layer when the filename table misses. */
const MATERIAL_ICON_EXTENSIONS: Readonly<Record<string, string>> = {
	backup: "document",
	bash: "console",
	cjs: "javascript",
	cts: "typescript",
	css: "css",
	go: "go",
	html: "html",
	icns: "image",
	ico: "image",
	java: "java",
	jpeg: "image",
	jpg: "image",
	js: "javascript",
	jsx: "react",
	json: "json",
	jsonl: "json",
	mjs: "javascript",
	md: "markdown",
	mts: "typescript",
	mmd: "mermaid",
	php: "php",
	png: "image",
	py: "python",
	responses: "json",
	rs: "rust",
	sb: "storybook",
	sh: "console",
	snap: "snapcraft",
	sql: "database",
	svg: "svg",
	toml: "toml",
	ts: "typescript",
	tsx: "react_ts",
	txt: "document",
	webm: "video",
	webp: "image",
	yaml: "yaml",
	yml: "yaml",
	zsh: "console",
};

function getMaterialIconName(path: string): string {
	const filename = basenameFromPath(path);
	const lowerFilename = filename.toLowerCase();
	const dotIndex = filename.lastIndexOf(".");
	const stem = dotIndex === -1 ? lowerFilename : lowerFilename.slice(0, dotIndex);
	const candidates = new Set([lowerFilename, stem]);
	let partialStem = stem;
	while (partialStem.includes(".")) {
		partialStem = partialStem.slice(0, partialStem.lastIndexOf("."));
		if (partialStem) candidates.add(partialStem);
	}
	for (const candidate of candidates) {
		const icon = MATERIAL_ICON_FILE_NAMES[candidate];
		if (icon) return icon;
	}
	if (dotIndex === -1) return DEFAULT_MATERIAL_ICON;
	const extension = filename.slice(dotIndex + 1).toLowerCase();
	const mappedExtension = MATERIAL_ICON_EXTENSIONS[extension];
	if (mappedExtension) return mappedExtension;
	return extension.length > 0 ? extension : DEFAULT_MATERIAL_ICON;
}

function getMaterialIconUrl(path: string): string {
	return `${MATERIAL_ICON_DIRECTORY}/${getMaterialIconName(path)}.svg`;
}

function getMaterialIconFallback(currentSrc: string): string | null {
	const documentIcon = `${MATERIAL_ICON_DIRECTORY}/${DEFAULT_MATERIAL_ICON}.svg`;
	if (currentSrc === MATERIAL_ICON_FALLBACK) return null;
	if (currentSrc === documentIcon || currentSrc.endsWith("/document.svg")) return MATERIAL_ICON_FALLBACK;
	return documentIcon;
}

function MaterialIconImage({ source, className }: { source: string; className?: string | undefined }) {
	const [resolvedSrc, setResolvedSrc] = useState(source);

	useEffect(() => {
		setResolvedSrc(source);
	}, [source]);

	return (
		<img
			src={resolvedSrc}
			alt=""
			width={16}
			height={16}
			className={className ?? "shrink-0"}
			aria-hidden="true"
			onError={() => {
				const fallback = getMaterialIconFallback(resolvedSrc);
				if (fallback) setResolvedSrc(fallback);
			}}
		/>
	);
}

export function MaterialFileIcon({ path, className }: { path: string; className?: string | undefined }) {
	return <MaterialIconImage source={getMaterialIconUrl(path)} className={className} />;
}
