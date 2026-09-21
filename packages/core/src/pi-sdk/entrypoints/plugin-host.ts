import { createLogger } from "../../logger";
import { getPiAgentDir } from "../agent-info";
import { createPiPackageHostService } from "../resources/package-host-service";
import { createPiSettings } from "../settings/settings";

const log = createLogger("plugin-host");

export function createPiPluginHost(systemProxyFallback: string | null) {
	const settings = createPiSettings(getPiAgentDir());
	try {
		settings.network.initHttpProxy();
	} catch (error) {
		log.error("Failed to initialize Pi HTTP settings; the settings recovery flow remains available:", error);
	}
	if (systemProxyFallback !== null) {
		try {
			settings.network.applySystemProxyFallback(systemProxyFallback);
		} catch (error) {
			log.error("Failed to apply the plugin-host system proxy fallback:", error);
		}
	}
	const packages = createPiPackageHostService(settings);
	let disposal: Promise<void> | null = null;
	return {
		handlePluginHostRequest: packages.handlePluginHostRequest,
		dispose(): Promise<void> {
			disposal ??= packages.dispose().then(() => settings.dispose());
			return disposal;
		},
	};
}
