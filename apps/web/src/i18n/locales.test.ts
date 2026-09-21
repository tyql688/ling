import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import zh from "./locales/zh-CN.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";

function flatten(value: unknown, prefix = ""): Map<string, string> {
	if (typeof value === "string") return new Map([[prefix, value]]);
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid locale entry: ${prefix}`);
	return new Map(
		Object.entries(value).flatMap(([key, child]) => [...flatten(child, prefix ? `${prefix}.${key}` : key)]),
	);
}

function semanticKey(key: string): string {
	// CLDR plural categories differ across languages; compare the underlying message key.
	return key.replace(/_(zero|one|two|few|many|other)$/, "");
}

describe("locale contracts", () => {
	it.each([
		["zh-CN", zh],
		["ja", ja],
		["ko", ko],
	] as const)("keeps %s semantic keys and interpolation names aligned", (_language, source) => {
		const english = flatten(en);
		const localized = flatten(source);
		const keys = (locale: Map<string, string>) => [...new Set([...locale.keys()].map(semanticKey))].sort();
		expect(keys(english)).toEqual(keys(localized));
		const variables = (locale: Map<string, string>, key: string) =>
			[
				...new Set(
					[...locale]
						.filter(([candidate]) => semanticKey(candidate) === key)
						.flatMap(([, text]) => [...text.matchAll(/\{\{\s*-?\s*([\w.]+)/g)].map((match) => match[1])),
				),
			].sort();
		// Singular wording may spell out "one" instead of interpolating count. Compare the
		// union across plural variants, preserving every other caller-supplied variable.
		for (const key of keys(english)) expect(variables(localized, key), key).toEqual(variables(english, key));
		const tags = (text: string) => [...text.matchAll(/<\/?([\w]+)\s*\/?\s*>/g)].map((match) => match[1]).sort();
		for (const [key, text] of localized) {
			const original = english.get(key) ?? english.get(`${semanticKey(key)}_other`);
			if (original !== undefined) expect(tags(text), key).toEqual(tags(original));
		}
	});
});
