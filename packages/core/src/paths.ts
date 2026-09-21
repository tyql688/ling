import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { homedir } from "node:os";
import { pathStringSchema } from "@ling/contracts/path-validation";
import { sessionRefSchema } from "@ling/contracts/session-ref";

/** Stable filesystem path identity: normalize on every platform and fold case on Windows. */
export function pathIdentity(path: string): string {
	const normalized = normalize(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isTildePath(path: string): boolean {
	return path === "~" || path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"));
}

export function expandTildePath(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	return isTildePath(path) ? join(home, path.slice(2)) : path;
}

export function absolutePathSchema(label: string, maxLength?: number) {
	return pathStringSchema(label, maxLength).refine((value) => isAbsolute(value), `${label} must be absolute`);
}

/** Native entry points must apply this host OS's rules, even for a browser client on another OS. */
export const nativeSessionRefSchema = sessionRefSchema.extend({ cwd: absolutePathSchema("Project path") });

/** Lexical containment; callers resolving filesystem aliases must canonicalize first. */
export function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
