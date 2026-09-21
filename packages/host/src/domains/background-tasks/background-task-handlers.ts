import { backgroundTasksProcedures } from "@ling/contracts/background-tasks-procedures";
import type { HostDomain } from "../../transport/host-domain";
import type { BackgroundTasks } from "./background-tasks";

export function createBackgroundTaskDomain(tasks: BackgroundTasks): HostDomain {
	return {
		handlers: {
			[backgroundTasksProcedures.list.channel]: async (_context, ref) => tasks.list(ref),
			[backgroundTasksProcedures.start.channel]: async (_context, { ref, command, timeoutMs }) =>
				tasks.start(ref, command, timeoutMs),
			[backgroundTasksProcedures.read.channel]: async (_context, { ref, id, offset }) => tasks.read(ref, id, offset),
			[backgroundTasksProcedures.stop.channel]: async (_context, { ref, id }) => tasks.stop(ref, id),
		},
	};
}
