import type { SessionMenuHandlers } from "./session-menu";

export interface SessionActionsMenuModel {
	session: { id: string; cwd: string; pinned: boolean; archived: boolean };
	handlers: SessionMenuHandlers;
}
