import type { PiAgentSessionServices } from "../types";

type PiResourceLoader = PiAgentSessionServices["resourceLoader"];

/** Preserve a freshly loaded extension runtime's Pi-resolved defaults, then
 * restore only previous values whose flag and value kind still match. This
 * covers both clean AgentSession generations and Pi's in-place empty-session
 * reload without retaining removed or type-changed plugin state. */
export function reconcilePiExtensionFlagValues(
	resourceLoader: PiResourceLoader,
	previousValues: ReadonlyMap<string, boolean | string>,
): void {
	const extensions = resourceLoader.getExtensions();
	const currentFlags = new Map<string, "boolean" | "string">();
	for (const extension of extensions.extensions) {
		for (const [name, flag] of extension.flags) {
			// Pi's runner exposes the first registration for duplicate names. The
			// loader independently resolves the first PROVIDED default, so retain its
			// fresh flagValues map rather than attempting to reconstruct it here.
			if (currentFlags.has(name)) continue;
			currentFlags.set(name, flag.type);
		}
	}
	for (const name of extensions.runtime.flagValues.keys()) {
		if (!currentFlags.has(name)) extensions.runtime.flagValues.delete(name);
	}
	for (const [name, value] of previousValues) {
		if (currentFlags.get(name) === typeof value) extensions.runtime.flagValues.set(name, value);
	}
}
