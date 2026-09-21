/**
 * Object keys that must never be accepted as data: taken as identifiers or object keys they open
 * prototype pollution. Rejected by the IPC schema guards and by plugin-source validation.
 */
export const RESERVED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Returns true when `value` contains an ASCII control character: anything below
 * 0x20 (space) or 0x7F (DEL). Used to reject control characters in user-supplied
 * strings (git branch names, proxy URLs, provider/model ids, npm commands, …).
 */
export function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

const utf8Encoder = new TextEncoder();
/** Shared UTF-8 accounting keeps storage limits consistent between browser and Host. */
export function utf8Bytes(value: string): number {
	return utf8Encoder.encode(value).byteLength;
}
