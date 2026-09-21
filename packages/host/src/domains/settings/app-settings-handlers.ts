import { appProcedures } from "@ling/contracts/application-procedures";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import type { AppSettingsStore } from "./app-settings";

export function createAppSettingsDomain({
	settingsStore,
	onChanged,
}: {
	settingsStore: AppSettingsStore;
	onChanged(): void;
}): HostDomain {
	const handlers: HostHandlers = {
		[appProcedures.getSettings.channel]: async () => settingsStore.readAppSettings(),

		[appProcedures.updateSettings.channel]: async (_context, value) => {
			const settings = await settingsStore.updateAppSettings(value);
			onChanged();
			return settings;
		},

		[appProcedures.resetSettings.channel]: async (_context) => {
			const settings = await settingsStore.resetAppSettings();
			onChanged();
			return settings;
		},
	};
	return { handlers };
}
