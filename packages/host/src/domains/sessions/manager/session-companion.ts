import type {
	ExtensionUiStateSnapshot,
	RuntimeCommandCatalogSnapshot,
	RuntimeExtensionUiSnapshot,
	SessionCommandCatalog,
	SessionRef,
} from "@ling/contracts/session";
import { createLingError } from "@ling/core/ling-error";

/** Companion snapshot protocol version. */
const PROTOCOL_VERSION = 1 as const;
/**
 * Command catalog serialization limit. 2MiB covers large slash/skill listings; oversized catalogs are rejected so a
 * bad extension cannot blow up IPC.
 */
const MAX_COMMAND_CATALOG_BYTES = 2 * 1024 * 1024;
/**
 * Extension UI state serialization limit. 4MiB allows fairly large panel snapshots; anything bigger should be split
 * rather than pushed as one blob.
 */
const MAX_EXTENSION_UI_BYTES = 4 * 1024 * 1024;

interface SessionCompanionBinding {
	runtimeId: string;
	generation: number;
	ref: SessionRef;
}

function cloneBounded<T>(value: T, maxBytes: number, projection: string): T {
	let cloned: T;
	let serialized: string;
	try {
		cloned = structuredClone(value);
		serialized = JSON.stringify(cloned);
	} catch (cause) {
		throw createLingError(
			{
				code: "PI_CAPABILITY_UNSUPPORTED",
				category: "compatibility",
				message: `The ${projection} projection is not serializable.`,
				retryable: false,
				userAction: "report",
				details: { projection },
			},
			cause,
		);
	}
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > maxBytes) {
		throw createLingError({
			code: "COMPANION_SNAPSHOT_TOO_LARGE",
			category: "compatibility",
			message: `The ${projection} projection exceeds its bounded snapshot limit.`,
			retryable: false,
			userAction: "report",
			details: { projection, bytes, maxBytes },
		});
	}
	return cloned;
}

export function createCommandCatalogSnapshot(
	binding: SessionCompanionBinding,
	revision: number,
	catalog: SessionCommandCatalog,
): RuntimeCommandCatalogSnapshot {
	return {
		protocolVersion: PROTOCOL_VERSION,
		runtimeId: binding.runtimeId,
		generation: binding.generation,
		ref: { ...binding.ref },
		revision,
		catalog: cloneBounded(catalog, MAX_COMMAND_CATALOG_BYTES, "commandCatalog"),
	};
}

export function createExtensionUiSnapshot(
	binding: SessionCompanionBinding,
	revision: number,
	state: ExtensionUiStateSnapshot,
): RuntimeExtensionUiSnapshot {
	return {
		protocolVersion: PROTOCOL_VERSION,
		runtimeId: binding.runtimeId,
		generation: binding.generation,
		ref: { ...binding.ref },
		revision,
		state: cloneBounded(state, MAX_EXTENSION_UI_BYTES, "extensionUi"),
	};
}
