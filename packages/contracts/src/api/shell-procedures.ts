import { z } from "zod";
import { SYSTEM_PERMISSION_TARGETS, type SystemPermissionState } from "../application";
import type { HostConnectionInfo } from "../host-shell";
import { portableAbsolutePathSchema } from "../path-validation";
import { viewedSessionRefSchema } from "../session-shell-validation";
import { externalWebUrlSchema, uiLanguageSchema, windowThemeSchema, windowZoomFactorSchema } from "../shell-validation";
import type { UpdateEvent, UpdateState } from "../update";
import type { SessionRef } from "../session-ref";
import {
	createProcedureClient,
	event,
	noArguments,
	request,
	returns,
	type ProcedureClient,
	type ProcedureTransport,
} from "../procedure";

const systemPermissionTargetSchema = z.enum(SYSTEM_PERMISSION_TARGETS);
const single =
	<Value>(schema: z.ZodType<Value>) =>
	(args: readonly unknown[]): [Value] => [schema.parse(args[0])];

/** Native paths are interpreted by Electron main; preload uses the same channel declarations without admitting input. */
export function createShellProcedures(pathSchema: z.ZodType<string> = portableAbsolutePathSchema("Path")) {
	return {
		host: { connection: request("desktop:get-host-connection", noArguments, returns<HostConnectionInfo>()) },
		lifecycle: {
			setViewedSession: request("desktop:set-viewed-session", single(viewedSessionRefSchema), returns<void>()),
			onActivateSession: event("desktop:activate-session", returns<SessionRef>()),
		},
		app: {
			openExternal: request("desktop:open-external", single(externalWebUrlSchema), returns<void>()),
			getSystemPermission: request(
				"desktop:get-system-permission",
				single(systemPermissionTargetSchema),
				returns<SystemPermissionState>(),
			),
			requestSystemPermission: request(
				"desktop:request-system-permission",
				single(systemPermissionTargetSchema),
				returns<SystemPermissionState>(),
			),
			openSystemPermission: request(
				"desktop:open-system-permission",
				single(systemPermissionTargetSchema),
				returns<void>(),
			),
		},
		window: {
			setZoomFactor: request("desktop:set-zoom-factor", single(windowZoomFactorSchema), returns<void>()),
			setTheme: request("desktop:set-theme", single(windowThemeSchema), returns<void>()),
			setLanguage: request("desktop:set-language", single(uiLanguageSchema), returns<void>()),
		},
		filesystem: {
			chooseDirectory: request("desktop:choose-directory", noArguments, returns<string | null>()),
			openPath: request("desktop:open-path", single(pathSchema), returns<void>()),
			revealPath: request("desktop:reveal-path", single(pathSchema), returns<void>()),
		},
		updates: {
			getState: request("desktop:get-update-state", noArguments, returns<UpdateState>()),
			check: request("desktop:check-for-update", noArguments, returns<void>()),
			download: request("desktop:download-update", noArguments, returns<void>()),
			install: request("desktop:install-update", noArguments, returns<void>()),
			onEvent: event("desktop:update-event", returns<UpdateEvent>()),
		},
	};
}
export const shellProcedures = createShellProcedures();
export type ShellProcedureClient = {
	[Domain in keyof typeof shellProcedures]: ProcedureClient<(typeof shellProcedures)[Domain]>;
};
export function createShellProcedureClient(transport: ProcedureTransport): ShellProcedureClient {
	return Object.fromEntries(
		Object.entries(shellProcedures).map(([name, table]) => [name, createProcedureClient(table, transport)]),
	) as ShellProcedureClient;
}
