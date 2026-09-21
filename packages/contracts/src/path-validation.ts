import { z } from "zod";
import { ABSOLUTE_PATH_MAX_CHARS } from "./path-bounds";

/** Storage readers may retain historical relative paths; request boundaries refine this primitive. */
export function pathStringSchema(label: string, maxLength = ABSOLUTE_PATH_MAX_CHARS) {
	return z
		.string()
		.min(1, `${label} must not be empty`)
		.max(maxLength, `${label} is too long`)
		.refine((value) => !value.includes("\0"), `${label} must not contain NUL`);
}

/** Accepts native absolute forms without interpreting a remote Host's path using the browser's OS. */
export function portableAbsolutePathSchema(label: string, maxLength = ABSOLUTE_PATH_MAX_CHARS) {
	return pathStringSchema(label, maxLength).refine(isPortableAbsolutePath, `${label} must be absolute`);
}

/** Recognizes absolute path spelling without assuming the browser and Host share an OS. */
export function isPortableAbsolutePath(value: string): boolean {
	return /^(?:[/\\]|[A-Za-z]:[/\\])/.test(value);
}
