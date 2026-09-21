import { permissionsProcedures } from "@ling/contracts/permissions-procedures";
import { accessEnabled } from "@ling/contracts/permissions";
import type { HostDomain } from "../../../transport/host-domain";
import type { ResourceReloadCoordinator } from "../../resources/resource-reload";
import { piResourceReloadError } from "../../resources/resource-reload";
import type { AccessActivationStore } from "./activation";
import { prepareRulesFile } from "./rules-file";

export function createPermissionDomain(options: {
	activation: AccessActivationStore;
	resources: ResourceReloadCoordinator;
	assertProject(cwd: string): Promise<void>;
	listOpenProjectPaths(): string[];
	onChanged(): void;
}): HostDomain {
	return {
		handlers: {
			[permissionsProcedures.read.channel]: async () => options.activation.read(),
			[permissionsProcedures.write.channel]: async (context, input) => {
				if (input.project) await options.assertProject(input.project.cwd);
				const result = await options.resources.mutateThenReloadPiResources(
					"Access mode change and resource reload failed",
					async () => {
						const { previous, current } = await options.activation.write(input, context.signal);
						return options
							.listOpenProjectPaths()
							.filter((cwd) => accessEnabled(previous, cwd) !== accessEnabled(current, cwd));
					},
				);
				options.onChanged();
				const failure = piResourceReloadError(result.reload);
				if (result.mutation.failed && failure)
					throw new AggregateError([result.mutation.error, failure], "Access mode change failed");
				if (result.mutation.failed) throw result.mutation.error;
				if (failure) throw failure;
				return { deferred: result.reload.sessions?.deferred ?? 0 };
			},
			[permissionsProcedures.prepareRulesFile.channel]: async (_context, cwd) => prepareRulesFile(cwd),
		},
	};
}
