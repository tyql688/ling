import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareReviewDiff, type ReviewDiffResult } from "./review-diff-worker";

function workerPort() {
	const port = {
		onmessage: null as ((event: MessageEvent<ReviewDiffResult>) => void) | null,
		onerror: null as ((event: ErrorEvent) => void) | null,
		onmessageerror: null as (() => void) | null,
		postMessage: vi.fn(),
		terminate: vi.fn(),
	};
	vi.stubGlobal(
		"Worker",
		class {
			constructor() {
				return port;
			}
		},
	);
	return port;
}

const request = { id: "document-a", path: "a.txt", lang: "text", original: "before", modified: "after" };

describe("review computation ownership", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("terminates and detaches a retired document before a late reply can publish", () => {
		const port = workerPort();
		const publish = vi.fn();
		const stop = prepareReviewDiff(request, publish);
		const lateReply = port.onmessage;
		stop();
		lateReply?.({ data: { status: "error", message: "old computation" } } as MessageEvent<ReviewDiffResult>);
		expect(publish).not.toHaveBeenCalled();
		expect(port.terminate).toHaveBeenCalledOnce();
		expect(port.onmessage).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("turns an unresponsive computation into one visible failure and releases its worker", () => {
		const port = workerPort();
		const publish = vi.fn();
		prepareReviewDiff(request, publish);
		vi.runAllTimers();
		expect(publish).toHaveBeenCalledExactlyOnceWith({ status: "error", message: expect.any(String) });
		expect(port.terminate).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("publishes worker failures without leaving the deadline or subscriptions alive", () => {
		const port = workerPort();
		const publish = vi.fn();
		prepareReviewDiff(request, publish);
		port.onerror?.({ message: "worker unavailable" } as ErrorEvent);
		vi.runAllTimers();
		expect(publish).toHaveBeenCalledExactlyOnceWith({ status: "error", message: "worker unavailable" });
		expect(port.onmessageerror).toBeNull();
		expect(port.terminate).toHaveBeenCalledOnce();
	});

	it("cleans up when the initial document cannot be posted", () => {
		const port = workerPort();
		const failure = new Error("clone failed");
		port.postMessage.mockImplementation(() => {
			throw failure;
		});
		expect(() => prepareReviewDiff(request, vi.fn())).toThrow(failure);
		expect(port.terminate).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});

it("keeps Windows checkout context unchanged when Git stores LF text", async () => {
	let result: ReviewDiffResult | undefined;
	const port = {
		onmessage: null as ((event: MessageEvent<typeof request>) => void) | null,
		postMessage: (value: ReviewDiffResult) => {
			result = value;
		},
	};
	vi.stubGlobal("self", port);
	try {
		await import("./review-diff.worker");
		const original = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
		const modified = original
			.replace("line 10\n", "changed 10\n")
			.replace("line 69\n", "changed 69\n")
			.replaceAll("\n", "\r\n");
		port.onmessage!({ data: { ...request, original, modified } } as MessageEvent<typeof request>);
		expect(result?.status).toBe("ok");
		if (result?.status !== "ok") throw new Error("Review preparation failed");
		expect(result.fileDiff.hunks).toHaveLength(2);
		expect(result.fileDiff.hunks[1]?.collapsedBefore).toBe(52);
		expect(result.fileDiff.hunks.map(({ additionLines, deletionLines }) => [additionLines, deletionLines])).toEqual([
			[1, 1],
			[1, 1],
		]);
	} finally {
		vi.unstubAllGlobals();
	}
});
