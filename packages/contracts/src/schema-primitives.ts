import { hasControlCharacter, RESERVED_OBJECT_KEYS } from "./text-validation";
import { z } from "zod";

/** IPC URL field cap; same magnitude as the external-open guard, keeps oversized URLs out of schemas. */
const MAX_IPC_URL_LENGTH = 4_096;

function assertSafeObjectInput(value: unknown, context: z.RefinementCtx): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		context.addIssue({ code: "custom", message: "Object prototype is not allowed" });
	}
	for (const key of RESERVED_OBJECT_KEYS) {
		if (Object.hasOwn(value, key)) {
			context.addIssue({ code: "custom", path: [key], message: `Object key ${key} is reserved` });
		}
	}
}

/** Zod's unknown-key check treats inherited names such as `__proto__` as shape
 * members. Pre-validating the object closes that prototype-key gap before parse. */
export function hardenObjectSchema<Schema extends z.ZodType>(schema: Schema) {
	return z.unknown().superRefine(assertSafeObjectInput).pipe(schema);
}

export function strictObject<Shape extends z.ZodRawShape>(shape: Shape) {
	return hardenObjectSchema(z.strictObject(shape));
}

export function boundedString(maxLength: number, label: string) {
	return z.string().max(maxLength, `${label} is too long`);
}

export function nonEmptyBoundedString(maxLength: number, label: string) {
	return boundedString(maxLength, label).refine((value) => value.trim().length > 0, `${label} must not be empty`);
}

export function controlFreeString(maxLength: number, label: string) {
	return nonEmptyBoundedString(maxLength, label).refine(
		(value) => !hasControlCharacter(value),
		`${label} must not contain control characters`,
	);
}

export function safeIdSchema(maxLength: number, label: string) {
	return nonEmptyBoundedString(maxLength, label)
		.refine((value) => !value.includes("\0"), `${label} must not contain NUL`)
		.refine((value) => !RESERVED_OBJECT_KEYS.has(value), `${label} is reserved`);
}

export function httpUrlSchema(label: string) {
	return controlFreeString(MAX_IPC_URL_LENGTH, label).refine((value) => {
		try {
			const parsed = new URL(value);
			return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
		} catch {
			return false;
		}
	}, `${label} must be an http:// or https:// URL`);
}
