/** Resolve a displayed path inside the current project. Host still validates symlinks and access. */
export function resolveProjectPath(
	source: string,
	cwd: string,
	{ documentPath = "", sourceKind = "path" }: { documentPath?: string; sourceKind?: "path" | "url" } = {},
): string | null {
	let path = source;
	if (sourceKind === "url") {
		if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[/\\]/i.test(path) && !path.startsWith("file://")) return null;
		path = path.startsWith("file://") ? path.slice(7) : path;
		// Decode URLs once. Tool arguments and directory entries already contain literal filenames.
		try {
			path = decodeURIComponent(path);
		} catch {
			/* A literal percent in a filename is valid. */
		}
	}
	path = path.replaceAll("\\", "/");
	const windows = /^[a-z]:[/\\]/i.test(cwd);
	if (windows && /^\/[a-z]:\//i.test(path)) path = path.slice(1);
	const root = cwd.replaceAll("\\", "/").replace(/\/$/, "");
	if (path.startsWith("/") || /^[a-z]:\//i.test(path)) {
		const prefix = root + "/";
		if (!(windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return null;
		path = path.slice(prefix.length);
	} else {
		const parent = documentPath.replaceAll("\\", "/").split("/").slice(0, -1).join("/");
		if (parent) path = parent + "/" + path;
	}
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part.includes("\0")) return null;
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.length ? parts.join("/") : null;
}
