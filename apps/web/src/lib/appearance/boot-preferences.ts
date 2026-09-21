import { uiBootPreferencesSchema } from "@ling/contracts/user-state";
/** This cache only avoids a wrong first paint; the Host snapshot supplies the actual preference. */
export const UI_BOOT_PREFERENCES_KEY = "ling:ui-boot-preferences";
export function readUiBootPreferences() {
	try {
		const raw = localStorage.getItem(UI_BOOT_PREFERENCES_KEY);
		if (raw === null || raw.length > 8192) return null;
		const parsed = uiBootPreferencesSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		// A denied or damaged disposable cache must not prevent loading the Host's saved state.
		return null;
	}
}
