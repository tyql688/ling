/** Special filenames to syntax language id, taking precedence over extensions. */
const LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
	".editorconfig": "ini",
	".env": "shell",
	".gitattributes": "text",
	".gitignore": "text",
	".npmrc": "ini",
	".nvmrc": "text",
	".prettierrc": "json",
	".yarnrc": "yaml",
	dockerfile: "dockerfile",
	gemfile: "ruby",
	makefile: "makefile",
};

/** File extension to syntax language id shared by the editor and change review. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
	bash: "shell",
	c: "c",
	cc: "cpp",
	cjs: "javascript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	cts: "typescript",
	diff: "diff",
	go: "go",
	h: "c",
	hpp: "cpp",
	html: "html",
	ini: "ini",
	java: "java",
	js: "javascript",
	json: "json",
	jsonc: "jsonc",
	jsonl: "json",
	jsx: "jsx",
	kt: "kotlin",
	kts: "kotlin",
	lua: "lua",
	md: "markdown",
	mdx: "mdx",
	mjs: "javascript",
	mts: "typescript",
	php: "php",
	plist: "xml",
	py: "python",
	rb: "ruby",
	rs: "rust",
	scss: "scss",
	sh: "shell",
	sql: "sql",
	svelte: "svelte",
	swift: "swift",
	toml: "toml",
	ts: "typescript",
	tsx: "tsx",
	txt: "text",
	vue: "vue",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	zsh: "shell",
};

export function codeLanguage(path: string): string {
	const filename = path.slice(path.lastIndexOf("/") + 1);
	const lowerFilename = filename.toLowerCase();
	const exact = LANGUAGE_BY_FILENAME[lowerFilename];
	if (exact !== undefined) return exact;
	const extensionIndex = lowerFilename.lastIndexOf(".");
	if (extensionIndex === -1) return "text";
	return LANGUAGE_BY_EXTENSION[lowerFilename.slice(extensionIndex + 1)] ?? "text";
}
