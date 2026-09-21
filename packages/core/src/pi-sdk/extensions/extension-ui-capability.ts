import type { PiExtensionUiContext } from "../types";

export interface ExtensionUiCapability {
	active: boolean;
	key: string;
}

export function staleExtensionUiContext(): Error {
	return Object.assign(new Error("This extension UI context is stale after session replacement or reload"), {
		code: "EXTENSION_UI_CONTEXT_STALE" as const,
	});
}

export function createExtensionUiCapabilities() {
	const capabilityBySession = new Map<string, ExtensionUiCapability>();
	const capabilityByContext = new WeakMap<PiExtensionUiContext, ExtensionUiCapability>();

	function isActiveExtensionUiCapability(capability: ExtensionUiCapability): boolean {
		return capability.active && capabilityBySession.get(capability.key) === capability;
	}

	function assertActiveExtensionUiCapability(capability: ExtensionUiCapability): void {
		if (!isActiveExtensionUiCapability(capability)) throw staleExtensionUiContext();
	}

	function createExtensionUiCapability(key: string): ExtensionUiCapability {
		const previous = capabilityBySession.get(key);
		if (previous) previous.active = false;
		const capability = { active: true, key };
		capabilityBySession.set(key, capability);
		return capability;
	}

	function guardExtensionUiContext(
		context: PiExtensionUiContext,
		capability: ExtensionUiCapability,
	): PiExtensionUiContext {
		const guardedFunctions = new WeakMap<(...args: never[]) => unknown, (...args: never[]) => unknown>();
		const guarded = new Proxy(context, {
			get(target, property, receiver) {
				assertActiveExtensionUiCapability(capability);
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				const existing = guardedFunctions.get(value);
				if (existing) return existing;
				const guardedFunction = (...args: never[]) => {
					assertActiveExtensionUiCapability(capability);
					return Reflect.apply(value, target, args);
				};
				guardedFunctions.set(value, guardedFunction);
				return guardedFunction;
			},
		});
		capabilityByContext.set(guarded, capability);
		return guarded;
	}

	function isPiExtensionUiContextActive(context: PiExtensionUiContext): boolean {
		const capability = capabilityByContext.get(context);
		return capability !== undefined && isActiveExtensionUiCapability(capability);
	}

	function disposeExtensionUiCapability(key: string): void {
		const capability = capabilityBySession.get(key);
		if (!capability) return;
		capability.active = false;
		capabilityBySession.delete(key);
	}

	function dispose(): void {
		for (const capability of capabilityBySession.values()) capability.active = false;
		capabilityBySession.clear();
	}
	return {
		assertActiveExtensionUiCapability,
		createExtensionUiCapability,
		guardExtensionUiContext,
		isPiExtensionUiContextActive,
		disposeExtensionUiCapability,
		dispose,
	};
}

export type ExtensionUiCapabilities = ReturnType<typeof createExtensionUiCapabilities>;
