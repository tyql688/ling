import type { ProjectTrustPrompt } from "@ling/contracts/project-trust-ui";
import type { ProcedureArgs } from "@ling/contracts/procedure";
import type { ProjectTrustRequest } from "@ling/contracts/project";
import { projectProcedures } from "@ling/contracts/project-procedures";
import type { DialogDismissEvent } from "@ling/contracts/session";
import { pathIdentity } from "@ling/core/paths";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import { createPairedDialog } from "../../transport/paired-dialog";
import type { HostHandle, HostRequestContext } from "../../transport/request-router";

/** Owns pending trust prompts and temporary trust decisions for one Host lifetime. */
export function createProjectTrustHost(handle: HostHandle, events: HostEventPublisher) {
	// Renderer prompt bridge.
	// Startup restore can request trust before the window (or its React tree) exists, so
	// requests are held in a map: pushed over the channel when a window is available, and
	// ALSO fetchable via project:trust:pending for the dialog's mount-time catch-up.

	let acceptingRequests = true;
	const sessionTrustedProjects = new Set<string>();

	function reuseSessionTrust(cwd: string): boolean {
		return sessionTrustedProjects.has(pathIdentity(cwd));
	}

	function rememberSessionTrust(cwd: string): void {
		sessionTrustedProjects.add(pathIdentity(cwd));
	}

	const trustDialog = createPairedDialog<
		{ cwd: string; prompt?: ProjectTrustPrompt },
		ProjectTrustRequest,
		string | null
	>({
		buildRequest: (requestId, input) => ({ requestId, ...input }),
		send: (request) => events.broadcast(projectProcedures.onTrustRequest.channel, request),
	});

	function promptForProjectTrust(
		cwd: string,
		signal?: AbortSignal,
		prompt?: ProjectTrustPrompt,
	): Promise<string | null> {
		if (!acceptingRequests) return Promise.resolve(null);
		if (signal?.aborted) return Promise.resolve(null);
		if (!prompt && reuseSessionTrust(cwd)) return Promise.resolve("session");
		const handle = trustDialog.requestWithHandle({ cwd, ...(prompt ? { prompt } : {}) });
		const cancel = (): void => {
			if (!handle.respond(null)) return;
			events.broadcast(projectProcedures.onTrustDismiss.channel, {
				requestId: handle.request.requestId,
			} satisfies DialogDismissEvent);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		return handle.response
			.then((choice) => {
				if (!prompt && acceptingRequests && choice === "session") rememberSessionTrust(cwd);
				return choice;
			})
			.finally(() => signal?.removeEventListener("abort", cancel));
	}

	handle(projectProcedures.pendingTrustRequests.channel, async (): Promise<ProjectTrustRequest[]> => {
		return trustDialog.pending();
	});

	handle(
		projectProcedures.respondTrust.channel,
		async (
			_event: HostRequestContext,
			requestId: ProcedureArgs<typeof projectProcedures.respondTrust>[0],
			choice: ProcedureArgs<typeof projectProcedures.respondTrust>[1],
		): Promise<void> => {
			const pending = trustDialog.pending().find((request) => request.requestId === requestId);
			if (pending && choice !== null) {
				if (!pending.prompt && !["trust", "session", "deny"].includes(choice))
					throw new Error("Invalid trust decision");
				if (pending.prompt?.kind === "select" && !pending.prompt.options.includes(choice))
					throw new Error("Invalid trust option");
				if (pending.prompt?.kind === "confirm" && !["yes", "no"].includes(choice))
					throw new Error("Invalid trust confirmation");
			}
			const response = { requestId, choice };
			trustDialog.respondOrThrow(response.requestId, response.choice);
		},
	);

	let disposed = false;
	return {
		prompt: promptForProjectTrust,
		dispose() {
			if (disposed) return;
			disposed = true;
			acceptingRequests = false;
			sessionTrustedProjects.clear();
			trustDialog.clearWhere(() => true, null);
		},
	};
}
