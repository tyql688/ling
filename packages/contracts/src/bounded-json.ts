import { RESERVED_OBJECT_KEYS } from "./text-validation";

export type BoundedJson = null | boolean | number | string | BoundedJson[] | BoundedJsonObject;

export interface BoundedJsonObject {
	[key: string]: BoundedJson;
}

export interface BoundedJsonLimits {
	maxDepth: number;
	maxNodes: number;
	maxObjectKeys: number;
	maxArrayItems: number;
	maxKeyChars: number;
	maxStringChars: number;
	maxBytes: number;
}

/** Returns the first reason an unknown value cannot cross a bounded JSON object
 * boundary. The traversal rejects values JSON would silently coerce (undefined,
 * non-finite numbers, sparse arrays) so callers never persist a shape different
 * from the one they validated. */
function inspectBoundedJsonObject(value: unknown, limits: BoundedJsonLimits): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "value must be a JSON object";
	}
	let nodes = 0;
	const ancestors = new WeakSet<object>();

	const visit = (current: unknown, depth: number): string | null => {
		nodes += 1;
		if (nodes > limits.maxNodes) return `value exceeds ${limits.maxNodes} JSON nodes`;
		if (depth > limits.maxDepth) return `value exceeds JSON depth ${limits.maxDepth}`;
		if (current === null || typeof current === "boolean") return null;
		if (typeof current === "number") return Number.isFinite(current) ? null : "numbers must be finite";
		if (typeof current === "string") {
			return current.length <= limits.maxStringChars ? null : `string exceeds ${limits.maxStringChars} characters`;
		}
		if (typeof current !== "object") return `unsupported JSON value type: ${typeof current}`;
		if (ancestors.has(current)) return "value must not contain a cycle";

		const prototype = Object.getPrototypeOf(current);
		if (Array.isArray(current)) {
			if (prototype !== Array.prototype) return "array prototype is not allowed";
			if (current.length > limits.maxArrayItems) return `array exceeds ${limits.maxArrayItems} items`;
			const ownKeys = Reflect.ownKeys(current);
			// Ordinary arrays own exactly one enumerable data property per item plus the
			// built-in non-enumerable length property. Reject hidden/symbol/custom keys and
			// accessors before reading values so validation never invokes user code.
			if (ownKeys.length !== current.length + 1 || !ownKeys.includes("length")) {
				return "array properties outside its JSON items are not allowed";
			}
			ancestors.add(current);
			try {
				for (let index = 0; index < current.length; index += 1) {
					const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
					if (!descriptor) return "sparse arrays are not allowed";
					if (!("value" in descriptor) || !descriptor.enumerable) {
						return "array items must be enumerable data properties";
					}
					const issue = visit(descriptor.value, depth + 1);
					if (issue) return issue;
				}
				return null;
			} finally {
				ancestors.delete(current);
			}
		}

		if (prototype !== Object.prototype && prototype !== null) return "object prototype is not allowed";
		const keys = Object.keys(current);
		if (Reflect.ownKeys(current).length !== keys.length) return "non-enumerable or symbol object keys are not allowed";
		if (keys.length > limits.maxObjectKeys) return `object exceeds ${limits.maxObjectKeys} keys`;
		ancestors.add(current);
		try {
			for (const key of keys) {
				if (RESERVED_OBJECT_KEYS.has(key)) return `object key ${key} is reserved`;
				if (key.length > limits.maxKeyChars) return `object key exceeds ${limits.maxKeyChars} characters`;
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor || !("value" in descriptor)) return "object accessors are not allowed";
				const issue = visit(descriptor.value, depth + 1);
				if (issue) return issue;
			}
			return null;
		} finally {
			ancestors.delete(current);
		}
	};

	const issue = visit(value, 0);
	if (issue) return issue;
	try {
		const serialized = JSON.stringify(value);
		if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes) {
			return `value exceeds ${limits.maxBytes} UTF-8 bytes`;
		}
	} catch {
		return "value cannot be serialized as JSON";
	}
	return null;
}

export function boundedJsonObjectValidationError(value: unknown, limits: BoundedJsonLimits): string | null {
	try {
		return inspectBoundedJsonObject(value, limits);
	} catch {
		// Unknown values can come from extension-owned model projections. Reflection on
		// a Proxy must fail validation without taking down the entire catalog/settings UI.
		return "value cannot be inspected as JSON";
	}
}
