import { resolve } from "node:path";
import { createAtomicFileStore } from "@ling/core/store/atomic-file-store";
import {
	accessActivationSchema,
	type AccessActivation,
	type AccessActivationUpdate,
} from "@ling/contracts/permissions";
import { featureDataPath } from "../../companions/feature-store";

/** Which projects load the permission system. Upstream rule files stay untouched. */
export function createAccessActivation(home: string) {
	const store = createAtomicFileStore<AccessActivation>({
		getPath: () => featureDataPath(home, "ling-permission-system", "pi-activation.json"),
		lockPath: "configured",
		maxBytes: 5 * 1_048_576,
		create: () => ({ revision: 0, defaultEnabled: false, projects: {} }),
		parse: (source) => accessActivationSchema.parse(JSON.parse(source) as unknown),
		serialize: (value) => `${JSON.stringify(value, null, 2)}\n`,
	});
	return {
		read: () => store.read(),
		async write(input: AccessActivationUpdate, signal: AbortSignal) {
			return store.update(
				(value) => {
					signal.throwIfAborted();
					if (value.revision !== input.expectedRevision)
						throw new Error("Access settings changed. Refresh before saving.");
					const previous = structuredClone(value);
					if (input.defaultEnabled !== undefined) value.defaultEnabled = input.defaultEnabled;
					if (input.project) {
						const cwd = resolve(input.project.cwd);
						if (input.project.enabled === null) delete value.projects[cwd];
						else value.projects[cwd] = input.project.enabled;
					}
					value.revision++;
					accessActivationSchema.parse(value);
					return { previous, current: value };
				},
				{ signal },
			);
		},
	};
}
export type AccessActivationStore = ReturnType<typeof createAccessActivation>;
