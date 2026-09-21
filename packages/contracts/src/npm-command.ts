import {
	PI_SETTINGS_NPM_ARGUMENT_MAX_CHARS,
	PI_SETTINGS_NPM_COMMAND_MAX_ARGS,
	PI_SETTINGS_NPM_COMMAND_MAX_CHARS,
} from "./pi-settings";
import { hasControlCharacter } from "./text-validation";

export function assertNpmCommandParts(parts: readonly string[]): asserts parts is readonly [string, ...string[]] {
	if (parts.length === 0 || parts.length > PI_SETTINGS_NPM_COMMAND_MAX_ARGS) throw new Error("Invalid npm command");
	for (const [index, part] of parts.entries()) {
		if (typeof part !== "string" || part.length > PI_SETTINGS_NPM_ARGUMENT_MAX_CHARS || hasControlCharacter(part)) {
			throw new Error("Invalid npm command argument");
		}
		if (index === 0 && part.trim().length === 0) throw new Error("Invalid npm command executable");
	}
}

/** Parses Ling's platform-independent argv text format used by Pi's npm setting. */
export function parseNpmCommand(input: string | null): string[] | undefined {
	if (input === null) return undefined;
	if (typeof input !== "string" || input.length > PI_SETTINGS_NPM_COMMAND_MAX_CHARS || hasControlCharacter(input)) {
		throw new Error("Invalid npm command");
	}
	if (!input.trim()) return undefined;
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let tokenStarted = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (char === undefined) throw new Error("Invalid npm command");
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (char === "\\") {
			const next = input[index + 1];
			const escapesSyntax =
				next !== undefined &&
				(quote === '"'
					? next === '"' || next === "\\"
					: quote === null && (next === '"' || next === "'" || /\s/.test(next)));
			if (escapesSyntax) {
				current += next;
				index += 1;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			tokenStarted = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (tokenStarted) parts.push(current);
			current = "";
			tokenStarted = false;
			continue;
		}
		current += char;
		tokenStarted = true;
	}
	if (quote) throw new Error("Invalid npm command: unterminated quote");
	if (tokenStarted) parts.push(current);
	assertNpmCommandParts(parts);
	return parts;
}
