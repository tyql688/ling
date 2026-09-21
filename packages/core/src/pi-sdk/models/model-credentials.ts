import type { PiProjectModelAccess } from "./model-project-access";
import type { PiModelsConfig } from "./models-config";
import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialSynchronizationState } from "@ling/contracts/model";
import { errorMessage } from "@ling/contracts/ling-error";
import { createLogger } from "../../logger";
import { assertSafeRegistryKey } from "./models-config-format";

const log = createLogger("model-config");

type PiAuthInteraction = Parameters<ModelRuntime["login"]>[2];

type PiAuthMethod = Parameters<ModelRuntime["login"]>[1];

interface CredentialSynchronizationOutcome {
	state: CredentialSynchronizationState;
	error: string | null;
}

async function runCredentialOperation(
	providerId: string,
	operation: () => Promise<unknown>,
	reconcileRuntime: () => Promise<void>,
): Promise<CredentialSynchronizationOutcome> {
	try {
		await operation();
		return { state: "ready", error: null };
	} catch (error) {
		if (!(error instanceof CredentialSynchronizationError)) throw error;
		// The SDK error is a commit marker, not a failed credential mutation. Never
		// compensate it back to the previous secret: rebuild from canonical auth.json
		// so every subsequent reader observes the committed provider state.
		try {
			await reconcileRuntime();
			return { state: "recovered", error: null };
		} catch (recoveryError) {
			const message = `Credentials were saved for ${providerId}, but Ling could not rebuild the local model state: ${errorMessage(recoveryError)}`;
			log.error(message);
			return { state: "pending", error: message };
		}
	}
}

export async function loginWithProvider(
	runtime: ModelRuntime,
	providerId: string,
	method: PiAuthMethod,
	interaction: PiAuthInteraction,
	reconcileRuntime: () => Promise<void>,
): Promise<CredentialSynchronizationOutcome> {
	const provider = runtime.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	if (method === "oauth") {
		if (!provider.auth.oauth) throw new Error(`${provider.name} does not support oauth login`);
	} else {
		if (!provider.auth.apiKey?.login) throw new Error(`${provider.name} does not support api_key login`);
	}
	return runCredentialOperation(providerId, () => runtime.login(providerId, method, interaction), reconcileRuntime);
}

export function createPiModelCredentials({
	projects,
	config,
}: {
	projects: PiProjectModelAccess;
	config: PiModelsConfig;
}) {
	const { withOpenProject } = projects;
	const { reloadGlobalModelRuntime, refreshModelRuntime } = config;

	async function storeDirectApiKey(
		runtime: ModelRuntime,
		provider: string,
		key: string,
		reconcileRuntime: () => Promise<void> = async () => {
			await reloadGlobalModelRuntime();
		},
	): Promise<void> {
		let promptHandled = false;
		const outcome = await loginWithProvider(
			runtime,
			provider,
			"api_key",
			{
				prompt: async (prompt) => {
					if (promptHandled || prompt.type !== "secret") {
						throw new Error(`Provider "${provider}" requires guided API key setup`);
					}
					promptHandled = true;
					return key;
				},
				notify: () => undefined,
			},
			reconcileRuntime,
		);
		if (!promptHandled) throw new Error(`Provider "${provider}" does not accept a stored API key`);
		if (outcome.state === "pending") {
			log.error(`API key was stored for ${provider}, but runtime synchronization remains pending: ${outcome.error}`);
		}
	}

	async function setProviderApiKeyMutation(provider: string, key: string): Promise<void> {
		assertSafeRegistryKey(provider, "Provider id");
		const trimmed = key.trim();
		if (!trimmed) throw new Error("API key must not be empty");
		const runtime = await reloadGlobalModelRuntime();
		await storeDirectApiKey(runtime, provider, trimmed);
		log.info(`stored API key for ${provider}`);
	}

	async function removeProviderAuthMutation(provider: string): Promise<void> {
		assertSafeRegistryKey(provider, "Provider id");
		const runtime = await reloadGlobalModelRuntime();
		const outcome = await runCredentialOperation(
			provider,
			() => runtime.logout(provider),
			async () => {
				await reloadGlobalModelRuntime();
			},
		);
		if (outcome.state === "pending") {
			log.error(
				`Credential removal committed for ${provider}, but runtime synchronization remains pending: ${outcome.error}`,
			);
		}
		log.info(`removed credential for ${provider}`);
	}

	async function removeProjectProviderAuthMutation(cwd: string, provider: string): Promise<void> {
		assertSafeRegistryKey(provider, "Provider id");
		await withOpenProject(cwd, async (services) => {
			const outcome = await runCredentialOperation(
				provider,
				() => services.modelRuntime.logout(provider),
				async () => {
					await refreshModelRuntime(services.modelRuntime, { allowNetwork: false });
				},
			);
			if (outcome.state === "pending") {
				log.error(
					`Credential removal committed for ${provider} through ${cwd}, but runtime synchronization remains pending: ${outcome.error}`,
				);
			}
		});
		log.info(`removed credential for ${provider} through project ${cwd}`);
	}
	return {
		storeDirectApiKey,
		setProviderApiKeyMutation,
		removeProviderAuthMutation,
		removeProjectProviderAuthMutation,
	};
}

export type PiModelCredentials = ReturnType<typeof createPiModelCredentials>;
