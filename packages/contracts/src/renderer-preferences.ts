import { isRecord } from "@ling/contracts/records";
import { utf8Bytes } from "@ling/contracts/text-validation";
/** Schema identifier inside meta. */
export const PREFERENCE_SCHEMA = "ling/renderer-preferences";
/** Meta version; bumping it requires migrating or rejecting old meta. */
export const PREFERENCE_VERSION = 1;
/** Meta JSON byte cap; meta is tiny, so 4Ki is enough to reject dirty data. */
const MAX_META_BYTES = 4 * 1024;
export interface PreferenceMeta {
	schema: typeof PREFERENCE_SCHEMA;
	version: typeof PREFERENCE_VERSION;
	writtenAt: number;
}

export function parseRendererPreferenceMeta(raw: string): PreferenceMeta | { futureVersion: number } {
	if (utf8Bytes(raw) > MAX_META_BYTES) throw new Error("Renderer preference metadata is too large");
	const value = JSON.parse(raw) as unknown;
	if (!isRecord(value) || value.schema !== PREFERENCE_SCHEMA) {
		throw new Error("Renderer preference metadata has an invalid schema");
	}
	if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
		throw new Error("Renderer preference metadata has an invalid version");
	}
	if ((value.version as number) > PREFERENCE_VERSION) return { futureVersion: value.version as number };
	if (
		value.version !== PREFERENCE_VERSION ||
		!Number.isSafeInteger(value.writtenAt) ||
		(value.writtenAt as number) < 0 ||
		Object.keys(value).some((key) => key !== "schema" && key !== "version" && key !== "writtenAt")
	) {
		throw new Error("Renderer preference metadata is corrupt");
	}
	return value as unknown as PreferenceMeta;
}
