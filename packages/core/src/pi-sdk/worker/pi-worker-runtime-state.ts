import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type { PiWorkerRuntimeState } from "../../pi-protocol/protocol";

async function buildPiWorkerRuntimeState(runtime: SessionRuntimePort, revision: number): Promise<PiWorkerRuntimeState> {
	// Every projection below is captured before the first await. The concrete Pi
	// runtime computes getStateSnapshot synchronously and returns an already-settled
	// promise, so replacement cannot splice fields from two identities into one frame.
	const snapshotPromise = runtime.getStateSnapshot();
	const ref = { ...runtime.ref };
	const sessionFile = runtime.sessionFile ?? null;
	const sessionName = runtime.getSessionName() ?? null;
	const commandCatalog = runtime.listCommands();
	const resources = runtime.getResourceSnapshot();
	const summary = runtime.summarize(0, "");
	const snapshot = await snapshotPromise;
	return {
		revision,
		ref,
		sessionFile,
		sessionName,
		snapshot,
		commandCatalog,
		resources,
		summary: {
			sessionFilePath: summary.sessionFilePath,
			...(summary.parentSessionFilePath === undefined ? {} : { parentSessionFilePath: summary.parentSessionFilePath }),
			...(summary.manualFork === undefined ? {} : { manualFork: summary.manualFork }),
			storedTitle: summary.title,
			updatedAt: summary.updatedAt,
			messageCount: summary.messageCount,
			preview: summary.preview,
			transcriptCacheKey: summary.transcriptCacheKey,
		},
	};
}

/** Serializes projection builds so concurrent bootstrap/event reads receive unique,
 * monotonic revisions even though each projection crosses an async API boundary. */
export function createPiWorkerRuntimeStateBuilder(runtime: SessionRuntimePort): () => Promise<PiWorkerRuntimeState> {
	let revision = 0;
	let tail = Promise.resolve();
	return () => {
		const operation = tail.then(async () => {
			const state = await buildPiWorkerRuntimeState(runtime, revision + 1);
			revision = state.revision;
			return state;
		});
		tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	};
}
