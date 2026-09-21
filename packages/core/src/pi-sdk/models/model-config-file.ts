import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { toError } from "@ling/core/ling-error";
import { readUtf8FileBounded } from "@ling/core/store/atomic-file-store";
import { join } from "node:path";

/** models.json read boundary (8MiB); still generous for multi-provider configs, anything larger is rejected as suspected corruption. */
export const PI_MODELS_JSON_MAX_BYTES = 8 * 1024 * 1024;

export function piModelsJsonPath(agentDir: string): string {
	return join(agentDir, "models.json");
}

export async function assertPiModelsJsonWithinReadBound(agentDir: string, signal?: AbortSignal): Promise<void> {
	await readUtf8FileBounded(piModelsJsonPath(agentDir), PI_MODELS_JSON_MAX_BYTES, signal);
}

/** ModelRuntime can refresh from inside synchronous extension/provider APIs.
 * Guard the instance method itself so those SDK-owned paths cannot bypass Ling's
 * bounded file boundary. A rejected internal fire-and-forget refresh would become
 * an unhandled rejection, so boundary failures are returned in the SDK result and
 * retained through getError(); Ling-owned mutations perform their stricter read
 * first and still reject transactionally. */
export function createPiModelConfigReadGuard() {
	const guardedRuntimes = new WeakSet<ModelRuntime>();
	return function installPiModelConfigReadGuard(runtime: ModelRuntime, agentDir: string): void {
		if (guardedRuntimes.has(runtime)) return;
		const refreshSdkRuntime = runtime.refresh.bind(runtime);
		const getSdkRuntimeError = runtime.getError.bind(runtime);
		let boundaryError: Error | null = null;

		runtime.refresh = async (options = {}) => {
			try {
				await assertPiModelsJsonWithinReadBound(agentDir, options.signal);
				boundaryError = null;
			} catch (error) {
				if (options.signal?.aborted) return { aborted: true, errors: new Map() };
				boundaryError = toError(error);
				return {
					aborted: false,
					errors: new Map([["models.json", boundaryError]]),
				};
			}
			return refreshSdkRuntime(options);
		};
		runtime.getError = () => {
			const sdkError = getSdkRuntimeError();
			const errors = [boundaryError?.message, sdkError].filter((error): error is string => error !== undefined);
			return errors.length > 0 ? [...new Set(errors)].join("\n\n") : undefined;
		};
		guardedRuntimes.add(runtime);
	};
}
