import { z } from "zod";
import { portableAbsolutePathSchema } from "./path-validation";
import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import {
	scheduleIdSchema,
	scheduleSaveSchema,
	scheduleStatusSchema,
	scheduleTargetSchema,
	type ScheduleModel,
	type SchedulesSnapshot,
} from "./schedules";

const cwdSchema = portableAbsolutePathSchema("Project path");
const one =
	<T>(schema: z.ZodType<T>) =>
	(args: readonly unknown[]): [T] => [schema.parse(args[0])];

export const schedulesProcedures = {
	snapshot: request("schedules:snapshot", noArguments, returns<SchedulesSnapshot>()),
	models: request("schedules:models", argumentsOf(one(cwdSchema)), returns<ScheduleModel[]>()),
	save: request("schedules:save", argumentsOf(one(scheduleSaveSchema)), returns<SchedulesSnapshot>()),
	setStatus: request("schedules:setStatus", argumentsOf(one(scheduleStatusSchema)), returns<SchedulesSnapshot>()),
	run: request("schedules:run", argumentsOf(one(scheduleIdSchema)), returns<{ occurrenceId: string }>()),
	stop: request("schedules:stop", argumentsOf(one(scheduleIdSchema)), returns<void>()),
	delete: request("schedules:delete", argumentsOf(one(scheduleTargetSchema)), returns<SchedulesSnapshot>()),
	markRead: request(
		"schedules:markRead",
		argumentsOf(one(z.string().min(1).max(200).nullable())),
		returns<SchedulesSnapshot>(),
	),
	onChanged: event("schedules:changed", returns<null>()),
};
