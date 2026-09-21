import type { PiAgentSessionServices } from "../types";
import type { PiCredentialProfileStore } from "./credential-store";

/** Holds the project generation open across a model operation, including resource reload barriers. */
export interface PiProjectModelAccess {
	withOpenProject<Result>(
		cwd: string,
		operation: (services: Pick<PiAgentSessionServices, "cwd" | "modelRuntime">) => Promise<Result>,
	): Promise<Result>;
}

export interface PiProjectModelCatalogAccess extends PiProjectModelAccess {
	hasProjectProviderCredentialConflict(cwd: string, providerId: string): boolean;
	readStoredProjectCredential(cwd: string, providerId: string): ReturnType<PiCredentialProfileStore["readStored"]>;
}
