import type { TerminalAttachResult, TerminalProfilesSnapshot, TerminalSnapshot } from "@ling/contracts/terminal";
import { terminalProcedures } from "@ling/contracts/terminal-procedures";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import { createTerminalService } from "@ling/host/domains/terminal/terminal-service";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import type { AppSettingsStore } from "../settings/app-settings";

interface TerminalDomain extends HostDomain {
	closeProject(cwd: string): Promise<void>;
	dispose(): Promise<void>;
}

export function createTerminalDomain({
	projectOperations,
	events,
	projectsRestored,
	settings,
}: {
	projectOperations: ProjectAccess;
	events: HostEventPublisher;
	projectsRestored: Promise<void>;
	settings: AppSettingsStore;
}): TerminalDomain {
	const { withKnownOpenProject } = projectOperations;

	const service = createTerminalService(events, settings);
	const handlers: HostHandlers = {
		[terminalProcedures.listProfiles.channel]: async (_event): Promise<TerminalProfilesSnapshot> => {
			await projectsRestored;
			return service.listProfiles();
		},

		[terminalProcedures.list.channel]: async (_event): Promise<TerminalSnapshot[]> => {
			await projectsRestored;
			return service.list();
		},

		[terminalProcedures.create.channel]: async (_event, value): Promise<TerminalSnapshot> => {
			await projectsRestored;
			return withKnownOpenProject(value.cwd, (cwd) => service.create({ ...value, cwd }));
		},

		[terminalProcedures.attach.channel]: async (_event, value): Promise<TerminalAttachResult> => {
			await projectsRestored;
			return service.attach(value);
		},

		[terminalProcedures.input.channel]: async (_event, value): Promise<void> => {
			await service.input(value);
		},

		[terminalProcedures.resize.channel]: async (_event, value): Promise<void> => {
			await service.resize(value);
		},

		[terminalProcedures.ack.channel]: async (_event, value): Promise<void> => {
			await service.ack(value);
		},

		[terminalProcedures.close.channel]: async (_event, value): Promise<void> => {
			await service.close(value);
		},
	};
	return { handlers, closeProject: (cwd) => service.closeProject(cwd), dispose: () => service.dispose() };
}
