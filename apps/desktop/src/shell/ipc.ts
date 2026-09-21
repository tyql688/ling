import type { ProcedureArgs, ProcedureResult, RequestProcedure } from "@ling/contracts/procedure";
import { createShellProcedures } from "@ling/contracts/api/shell-procedures";
import { pathStringSchema } from "@ling/contracts/path-validation";
import { ipcMain, type BrowserWindow } from "electron";
import { isAbsolute } from "node:path";

export const nativeAbsolutePathSchema = pathStringSchema("Path").refine(isAbsolute, "Path must be absolute");
const procedures = createShellProcedures(nativeAbsolutePathSchema);
type ShellProcedures = typeof procedures;
type DesktopHandlers = {
	[Domain in keyof ShellProcedures]: {
		[Name in keyof ShellProcedures[Domain] as ShellProcedures[Domain][Name] extends RequestProcedure ? Name : never]: (
			...args: ProcedureArgs<ShellProcedures[Domain][Name]>
		) => ProcedureResult<ShellProcedures[Domain][Name]> | Promise<ProcedureResult<ShellProcedures[Domain][Name]>>;
	};
};

/** Sender and frame checks precede schema parsing. Registration owns every installed handler even if a later binding fails. */
export function createDesktopIpc(options: { getWindow(): BrowserWindow | null; isClosing(): boolean }) {
	const registered: string[] = [];
	return {
		register(handlers: DesktopHandlers) {
			for (const [domain, table] of Object.entries(procedures)) {
				const owned = handlers[domain as keyof DesktopHandlers] as Record<string, (...args: unknown[]) => unknown>;
				for (const [name, procedure] of Object.entries(table)) {
					if (procedure.kind !== "request") continue;
					const handler = owned[name];
					if (!handler) throw new Error(`Missing Desktop handler: ${procedure.channel}`);
					ipcMain.handle(procedure.channel, (event, ...args: unknown[]) => {
						if (options.isClosing()) throw new Error("Ling is shutting down");
						const window = options.getWindow();
						if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
							throw new Error("Untrusted Electron IPC sender");
						return handler(...procedure.parse(args));
					});
					registered.push(procedure.channel);
				}
			}
		},
		dispose() {
			for (const channel of registered) ipcMain.removeHandler(channel);
			registered.length = 0;
		},
	};
}
