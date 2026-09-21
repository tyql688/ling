import { PLUGIN_SOURCE_MAX_CHARS } from "@ling/contracts/plugin";
import { RESERVED_OBJECT_KEYS } from "@ling/contracts/text-validation";

const EXPLICIT_SOURCE = /^(npm:|git:|github:|https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|\.{1,2}\/|\/|~)/;
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@.+)?$/;
const GIT_SSH_SHORTHAND = /^git@[\w.-]+:/;
const GIT_HOST_SHORTHAND = /^[a-z0-9][\w-]*(\.[\w-]+)+\/[^/]+\/.+/i;
const NPM_SOURCE = /^npm:/;
const GIT_SOURCE = /^(git:|github:|https?:\/\/|ssh:\/\/)/;

function assertPluginSource(source: unknown): asserts source is string {
	if (typeof source !== "string") throw new Error("Invalid plugin source");
	const trimmed = source.trim();
	if (
		!trimmed ||
		trimmed.length > PLUGIN_SOURCE_MAX_CHARS ||
		trimmed.startsWith("-") ||
		RESERVED_OBJECT_KEYS.has(trimmed)
	) {
		throw new Error("Invalid plugin source");
	}
	for (let index = 0; index < trimmed.length; index += 1) {
		const code = trimmed.charCodeAt(index);
		if (code < 32 || code === 127) throw new Error("Invalid plugin source");
	}
	if (trimmed.startsWith("npm:")) {
		const npmSource = trimmed.slice("npm:".length);
		if (/\s/.test(npmSource) || !NPM_NAME.test(npmSource)) throw new Error("Invalid npm plugin source");
	}
}

export function normalizePluginSource(source: string): string {
	assertPluginSource(source);
	const trimmed = source.trim();
	if (EXPLICIT_SOURCE.test(trimmed)) return trimmed;
	if (GIT_SSH_SHORTHAND.test(trimmed) || GIT_HOST_SHORTHAND.test(trimmed)) return `git:${trimmed}`;
	if (NPM_NAME.test(trimmed)) return `npm:${trimmed}`;
	return trimmed;
}

export function pluginSourceUsesNpm(source: string): boolean {
	return NPM_SOURCE.test(normalizePluginSource(source));
}

export function pluginSourceUsesGit(source: string): boolean {
	return GIT_SOURCE.test(normalizePluginSource(source));
}
