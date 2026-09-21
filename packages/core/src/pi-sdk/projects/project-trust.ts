import type { ProjectTrustChoice } from "@ling/contracts/project";
import { homedir } from "node:os";
import { createLogger } from "../../logger";
import { getPiAgentDir } from "../agent-info";
import { createProjectTrustStore, createSettingsManager, hasPiTrustRequiringProjectResources } from "../sdk-factories";

const log = createLogger("pi-project-trust");

type PiProjectTrustPrompt = (cwd: string) => Promise<ProjectTrustChoice | null>;

/**
 * Ling's version of pi's project-trust resolution (pi's own `resolveProjectTrusted`
 * is CLI-internal, but every primitive it composes is exported). Order mirrors pi:
 * no gated resources -> trusted; stored decision -> use it; `defaultProjectTrust`
 * setting -> always/never; otherwise prompt the user and honor "remember".
 */
export function createPiProjectTrustResolver(promptForTrust: PiProjectTrustPrompt): (cwd: string) => Promise<boolean> {
	const sessionTrustedProjects = new Set<string>();
	return async (cwd) => {
		if (!hasPiTrustRequiringProjectResources(cwd)) return true;
		// One entry per project the user explicitly session-trusted, released with the host
		// process. That is the user's own decision, so it is not capped or evicted.
		if (sessionTrustedProjects.has(cwd)) return true;

		const store = createProjectTrustStore();
		const stored = store.get(cwd);
		if (stored !== null) return stored;

		// Same bootstrap trick as pi's CLI: read global settings with the project treated as
		// untrusted, purely to learn the defaultProjectTrust policy.
		const policy = createSettingsManager(homedir(), getPiAgentDir(), {
			projectTrusted: false,
		}).getDefaultProjectTrust();
		if (policy === "always") return true;
		if (policy === "never") return false;

		const choice = await promptForTrust(cwd);
		log.info(`trust decision for ${cwd}: ${choice}`);
		switch (choice) {
			case "trust":
				store.set(cwd, true);
				return true;
			case "session":
				sessionTrustedProjects.add(cwd);
				return true;
			case "deny":
				store.set(cwd, false);
				return false;
			case null:
				// Dismissed: untrusted for now, ask again next time (pi's cancel behavior).
				return false;
		}
	};
}
