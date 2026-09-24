import { voiceProcedures } from "@ling/contracts/voice-procedures";
import { requestCancelled, requestCapacityExceeded } from "@ling/core/ling-error";
import type { PiWorkerClient } from "../../../workers/pi/pi-worker-client";
import type { HostRequestContext } from "../../../transport/request-router";
import type { HostDomain } from "../../../transport/host-domain";
import type { BuiltinFeatureStore } from "../../companions/builtin-features";
import { piResourceReloadError, type ResourceReloadCoordinator } from "../../resources/resource-reload";

export function createVoiceDomain(options: {
	features: Pick<BuiltinFeatureStore, "requireEnabled">;
	piWorker: Pick<PiWorkerClient, "readVoice" | "configureVoice" | "transcribeVoice">;
	resources: Pick<ResourceReloadCoordinator, "mutateThenReloadPiResources">;
	assertProject(cwd: string): Promise<void>;
}) {
	let stopping = false;
	let active: { id: string; clientId: string; controller: AbortController; task: Promise<unknown> } | null = null;
	async function admit(cwd: string) {
		if (stopping) throw requestCancelled("Voice input is shutting down");
		await options.features.requireEnabled("voice");
		await options.assertProject(cwd);
	}
	function run<T>(
		context: HostRequestContext,
		id: string,
		cwd: string,
		task: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (active) return Promise.reject(requestCapacityExceeded("voice", 1, "Another voice operation is in progress"));
		const controller = new AbortController();
		const signal = AbortSignal.any([context.signal, controller.signal]);
		const pending = (async () => {
			await admit(cwd);
			signal.throwIfAborted();
			const result = await task(signal);
			signal.throwIfAborted();
			await options.features.requireEnabled("voice");
			return result;
		})().finally(() => {
			if (active?.task === pending) active = null;
		});
		active = { id, clientId: context.clientId, controller, task: pending };
		return pending;
	}
	function cancel() {
		active?.controller.abort(requestCancelled("Voice operation cancelled"));
	}
	const domain = {
		handlers: {
			[voiceProcedures.read.channel]: async (context, input) => {
				await admit(input.cwd);
				return options.piWorker.readVoice(input.cwd, context.signal);
			},
			[voiceProcedures.configure.channel]: (context, input) =>
				run(context, input.operationId, input.cwd, async (signal) => {
					const result = await options.resources.mutateThenReloadPiResources(
						"Voice settings and resource reload failed",
						async () => (await options.piWorker.configureVoice(input, signal)) ?? undefined,
						{ mode: "configuration", reloadProjectCatalogs: false },
					);
					if (result.mutation.failed) {
						const failure = piResourceReloadError(result.reload);
						if (failure) throw new AggregateError([result.mutation.error, failure], "Voice settings failed");
						throw result.mutation.error;
					}
					return result.reload;
				}),
			[voiceProcedures.transcribe.channel]: (context, input) =>
				run(context, input.operationId, input.cwd, (signal) => options.piWorker.transcribeVoice(input, signal)),
			[voiceProcedures.cancel.channel]: async (context, input) => {
				if (active?.id === input.operationId && active.clientId === context.clientId) cancel();
			},
		},
		prepareShutdown() {
			stopping = true;
			cancel();
		},
		async dispose() {
			stopping = true;
			cancel();
			await Promise.allSettled(active ? [active.task] : []);
		},
	} satisfies HostDomain;
	return {
		...domain,
		cancel,
		disconnectClient(clientId: string) {
			if (active?.clientId === clientId) cancel();
		},
	};
}
