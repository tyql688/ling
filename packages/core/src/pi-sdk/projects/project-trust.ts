import {
	type ProjectTrustContext,
	type ProjectTrustHandler,
	type ExtensionUIDialogOptions,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PiLoadExtensionsResult } from "../types";
import type { ProjectTrustPrompt } from "@ling/contracts/project-trust-ui";
import { z } from "zod";
import { toError } from "../../ling-error";
import { homedir } from "node:os";
import { createLogger } from "../../logger";

const log = createLogger("pi-project-trust");

type PiProjectTrustPrompt = (cwd: string, prompt?: ProjectTrustPrompt, signal?: AbortSignal) => Promise<string | null>;

/** Global trust hooks run before saved decisions and policy; project resources remain gated. */
export function createPiProjectTrustResolver(
	promptForTrust: PiProjectTrustPrompt,
): (cwd: string, extensions: PiLoadExtensionsResult) => Promise<boolean> {
	const sessionTrustedProjects = new Set<string>();
	return async (cwd, extensions) => {
		if (!hasTrustRequiringProjectResources(cwd)) return true;
		const store = new ProjectTrustStore(getAgentDir());
		const ask = (prompt: ProjectTrustPrompt, options?: ExtensionUIDialogOptions) => {
			const signals = [
				...(options?.signal ? [options.signal] : []),
				...(options?.timeout === undefined ? [] : [AbortSignal.timeout(options.timeout)]),
			];
			return promptForTrust(cwd, prompt, signals.length ? AbortSignal.any(signals) : undefined).catch(
				(error: unknown) => {
					if (signals.some((signal) => signal.aborted)) return null;
					throw error;
				},
			);
		};
		const context: ProjectTrustContext = {
			cwd,
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async (title, choices, options) =>
					(await ask({ kind: "select", title, options: choices }, options)) ?? undefined,
				confirm: async (title, message, options) => (await ask({ kind: "confirm", title, message }, options)) === "yes",
				input: async (title, placeholder, options) =>
					(await ask({ kind: "input", title, placeholder: placeholder ?? "" }, options)) ?? undefined,
				notify: (title) => {
					void promptForTrust(cwd, { kind: "notify", title }).catch((error) =>
						log.error("Project trust notification failed", toError(error)),
					);
				},
			},
		};
		for (const error of extensions.errors)
			context.ui.notify(`Project trust extension ${error.path}: ${error.error}`, "error");
		for (const extension of extensions.extensions)
			for (const handler of [...(extension.handlers.get("project_trust") ?? [])]) {
				try {
					const response = await (handler as ProjectTrustHandler)({ type: "project_trust", cwd }, context);
					if (response === undefined) continue;
					const result = z
						.strictObject({ trusted: z.enum(["yes", "no", "undecided"]), remember: z.boolean().optional() })
						.parse(response);
					if (result.trusted === "undecided") continue;
					const trusted = result.trusted === "yes";
					if (result.remember) store.set(cwd, trusted);
					return trusted;
				} catch (error) {
					context.ui.notify(`Project trust extension ${extension.path}: ${toError(error).message}`, "error");
				}
			}

		// One entry per project the user explicitly session-trusted, released with the host
		// process. That is the user's own decision, so it is not capped or evicted.
		if (sessionTrustedProjects.has(cwd)) return true;

		const stored = store.get(cwd);
		if (stored !== null) return stored;

		// Trust policy is global; project settings cannot grant their own trust.
		const policy = SettingsManager.create(homedir(), getAgentDir(), {
			projectTrusted: false,
		}).getDefaultProjectTrust();
		if (policy === "always") return true;
		if (policy === "never") return false;

		const choice = z
			.enum(["trust", "session", "deny"])
			.nullable()
			.parse(await promptForTrust(cwd));
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
