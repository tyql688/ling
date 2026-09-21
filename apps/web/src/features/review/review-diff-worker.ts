import type { FileDiffMetadata } from "@pierre/diffs";

export interface ReviewDiffRequest {
	id: string;
	path: string;
	/** Selected by the UI's existing language registry so this worker never bundles its grammar loaders. */
	lang: string;
	original: string;
	modified: string;
}

export type ReviewDiffResult = { status: "ok"; fileDiff: FileDiffMetadata } | { status: "error"; message: string };

/** One document owns one computation. Switching files terminates the old algorithm, not just its reply. */
export function prepareReviewDiff(
	request: ReviewDiffRequest,
	onResult: (result: ReviewDiffResult) => void,
): () => void {
	const worker = new Worker(new URL("./review-diff.worker.ts", import.meta.url), {
		type: "module",
		name: "ling-review-diff",
	});
	let stopped = false;
	const stop = () => {
		stopped = true;
		clearTimeout(deadline);
		worker.onmessage = null;
		worker.onerror = null;
		worker.onmessageerror = null;
		worker.terminate();
	};
	const finish = (result: ReviewDiffResult) => {
		if (stopped) return;
		stop();
		onResult(result);
	};
	// Pathological edits must not keep an unresponsive worker or an indefinitely busy review pane.
	const deadline = setTimeout(() => finish({ status: "error", message: "Review diff computation timed out" }), 15_000);
	worker.onmessage = ({ data }: MessageEvent<ReviewDiffResult>) => finish(data);
	worker.onerror = (event) => finish({ status: "error", message: event.message });
	worker.onmessageerror = () =>
		finish({ status: "error", message: "Review diff worker returned an unreadable result" });
	try {
		worker.postMessage(request);
	} catch (cause) {
		stop();
		throw cause;
	}
	return stop;
}
