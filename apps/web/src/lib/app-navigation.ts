import type { SessionRef } from "@ling/contracts/session-ref";
import type { SettingsCategory } from "@renderer/lib/navigation-state";
import { createContext, useContext } from "react";

/** Navigation entry points the app shell owns; feature pages call these instead of touching shell state. */
export interface AppNavigation {
	openSession(ref: SessionRef): Promise<void>;
	/** Puts text into the new-conversation draft for a project and focuses the composer. */
	compose(cwd: string, text: string): void;
	openSettings(category: SettingsCategory): void;
	openPath(path: string): Promise<void>;
}

export const AppNavigationContext = createContext<AppNavigation | null>(null);

export function useAppNavigation(): AppNavigation {
	const navigation = useContext(AppNavigationContext);
	if (navigation === null) throw new Error("App navigation is unavailable outside the ready app");
	return navigation;
}
