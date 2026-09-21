import { schedulesProcedures } from "@ling/contracts/schedules-procedures";
import type { HostDomain } from "../../transport/host-domain";
import type { Schedules } from "./schedules";

export function createScheduleDomain(schedules: Schedules): HostDomain {
	return {
		handlers: {
			[schedulesProcedures.snapshot.channel]: async () => schedules.snapshot(),
			[schedulesProcedures.models.channel]: async (_context, cwd) => schedules.models(cwd),
			[schedulesProcedures.save.channel]: async (_context, { id, expectedRevision, task }) =>
				schedules.save(id, expectedRevision, task),
			[schedulesProcedures.setStatus.channel]: async (_context, { id, status, revision }) =>
				schedules.setStatus(id, status, revision),
			[schedulesProcedures.run.channel]: async (_context, { id }) => schedules.run(id),
			[schedulesProcedures.stop.channel]: async (_context, { id }) => schedules.stop(id),
			[schedulesProcedures.delete.channel]: async (_context, { id, revision }) => schedules.delete(id, revision),
			[schedulesProcedures.markRead.channel]: async (_context, id) => schedules.markRead(id),
		},
	};
}
