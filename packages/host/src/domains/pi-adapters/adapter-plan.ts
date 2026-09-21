import { resolve } from "node:path";
import type { PiAdapterPlan } from "@ling/contracts/companions";
import { accessEnabled, PERMISSION_PACKAGE } from "@ling/contracts/permissions";
import { TODO_PACKAGE } from "@ling/contracts/todo";
import { createLogger } from "@ling/core/logger";
import { toError } from "@ling/core/ling-error";
import { resolvePiPackageEntry } from "./package-entry";
import type { AccessActivationStore } from "./permission-system/activation";
import type { BuiltinFeatureStore } from "../companions/builtin-features";

const log = createLogger("pi-adapters");

/** Resolves the bundled Pi packages once and answers the worker's per-project plan requests. */
export function createPiAdapterPlan(activation: AccessActivationStore, features: BuiltinFeatureStore) {
	const entry = (name: string, extension: string) =>
		resolvePiPackageEntry(name, extension).catch((error: unknown) => {
			log.error(`bundled Pi package is unavailable: ${name}:`, toError(error));
			return null;
		});
	const todo = entry(TODO_PACKAGE, "index.ts");
	const permissions = entry(PERMISSION_PACKAGE, "src/index.ts");
	async function permissionsEnabled(cwd: string) {
		try {
			return accessEnabled(await activation.read(), resolve(cwd));
		} catch (error) {
			// An unreadable choice must not open projects with full access, or stop them from opening.
			log.error("access mode settings are unreadable; the permission system stays on:", toError(error));
			return true;
		}
	}
	return {
		async read(cwd: string): Promise<PiAdapterPlan> {
			const [todoEntry, permissionEntry, enabled, state] = await Promise.all([
				todo,
				permissions,
				permissionsEnabled(cwd),
				features.read(),
			]);
			return {
				features: state.enabled,
				todo: state.enabled.todo ? todoEntry : null,
				permissions: permissionEntry ? { entry: permissionEntry, enabled: state.enabled.permissions && enabled } : null,
			};
		},
	};
}
