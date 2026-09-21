import { editorLanguageProcedures as procedures } from "@ling/contracts/editor-language-procedures";
import { createLogger } from "@ling/core/logger";
import type { ProjectAccess } from "../../runtime/project-access";
import type { HostEventPublisher } from "../../transport/event-bus";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import { createEditorLanguageService } from "./language-service";
import { formatProjectDocument } from "./project-formatter";

const log = createLogger("editor-language");
export function createEditorLanguageDomain(options: {
	projectOperations: ProjectAccess;
	projectsRestored: Promise<void>;
	events: HostEventPublisher;
	isTrusted(cwd: string): Promise<boolean>;
}) {
	const service = createEditorLanguageService({
		isTrusted: options.isTrusted,
		onDiagnostics: (clientId, payload) => options.events.send(clientId, procedures.onDiagnostics.channel, payload),
		onError: (error) => log.error("language service failed:", error),
	});
	const handlers: HostHandlers = {
		[procedures.save.channel]: async (context, value) =>
			service.save(context.clientId, value.id, value.path, value.text),
		[procedures.format.channel]: async (context, value) => {
			await options.projectsRestored;
			return options.projectOperations.withKnownOpenProject(value.cwd, async (cwd) =>
				formatProjectDocument({ ...value, cwd }, value.range, await options.isTrusted(cwd), context.signal),
			);
		},
		[procedures.open.channel]: async (context, value) => {
			await options.projectsRestored;
			return options.projectOperations.withKnownOpenProject(value.cwd, (cwd) =>
				service.open(context.clientId, { ...value, cwd }, context.signal),
			);
		},
		[procedures.change.channel]: async (context, value) =>
			options.projectOperations.withKnownOpenProject(value.cwd, (cwd) =>
				service.change(context.clientId, value.id, { ...value, cwd }),
			),
		[procedures.call.channel]: async (context, value) =>
			options.projectOperations.withKnownOpenProject(service.cwd(context.clientId, value.id), () =>
				service.call(context.clientId, value, context.signal),
			),
		[procedures.close.channel]: async (context, value) => service.close(context.clientId, value.id, value.path),
		[procedures.cancel.channel]: async (context, value) => service.cancel(context.clientId, value.id, value.requestId),
	};
	return {
		handlers,
		prepareShutdown() {
			service.prepareShutdown();
		},
		async dispose() {
			await service.dispose();
		},
		closeProject: service.closeProject,
		releaseClient: service.releaseClient,
	} satisfies HostDomain & { closeProject(cwd: string): Promise<void>; releaseClient(clientId: string): Promise<void> };
}
