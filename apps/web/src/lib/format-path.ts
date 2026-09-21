import { isWindows } from "./platform";

/** DISPLAY-ONLY: shorten an absolute path under the user's home to ~/… (never feed the
 * result back into IPC — handlers expect real paths). */
export function tildify(path: string): string {
	const home = window.ling.env.home;
	if (home === null) return path;
	if (path === home) return "~";
	// Require a native separator so a sibling that merely extends the home name is not shortened.
	if (path.startsWith(home)) {
		const sep = path.charCodeAt(home.length);
		// 47 = "/", 92 = "\" on Windows.
		if (sep === 47 || (isWindows && sep === 92)) return `~${path.slice(home.length)}`;
	}
	return path;
}

export function basenameFromPath(path: string): string {
	let end = path.length;
	while (end > 1) {
		const code = path.charCodeAt(end - 1);
		if (code !== 47 && (!isWindows || code !== 92)) break;
		end--;
	}
	const trimmed = path.slice(0, end);
	for (let index = trimmed.length - 1; index >= 0; index--) {
		const code = trimmed.charCodeAt(index);
		if (code === 47 || (isWindows && code === 92)) {
			const basename = trimmed.slice(index + 1);
			return basename.length > 0 ? basename : trimmed;
		}
	}
	return trimmed;
}
