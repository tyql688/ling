import { describe, expect, it } from "vitest";
import type { PiWorkerResponse, PiWorkerResponseChunk } from "./protocol";
import {
	PI_WORKER_PROTOCOL_VERSION,
	PI_WORKER_RESPONSE_CHUNK_MAX_CHARS,
	PI_WORKER_RESPONSE_MAX_BYTES,
} from "./wire-format";
import {
	appendPiWorkerResponseChunk,
	iteratePiWorkerResponseFrames,
	preparePiWorkerResponse,
	type PiWorkerResponseChunkAccumulator,
} from "./response-stream";

const response = (result: unknown): Extract<PiWorkerResponse, { kind: "result" }> => ({
	kind: "result",
	protocolVersion: PI_WORKER_PROTOCOL_VERSION,
	generation: 1,
	requestId: "request",
	method: "session.list",
	result,
});
const chunk = (overrides: Partial<PiWorkerResponseChunk> = {}): PiWorkerResponseChunk => ({
	kind: "resultChunk",
	protocolVersion: PI_WORKER_PROTOCOL_VERSION,
	generation: 1,
	requestId: "request",
	method: "session.list",
	sequence: 0,
	final: true,
	data: "[]",
	...overrides,
});

describe("Pi response streams", () => {
	it("keeps small responses in one frame", () => {
		const input = response({ items: ["small"] });
		expect([...iteratePiWorkerResponseFrames(preparePiWorkerResponse(input))]).toEqual([input]);
	});

	it("reassembles large Unicode content across chunk boundaries", () => {
		const input = response({ text: "中文😀".repeat(PI_WORKER_RESPONSE_CHUNK_MAX_CHARS) });
		let accumulator: PiWorkerResponseChunkAccumulator | undefined;
		let result: unknown;
		const frames = [...iteratePiWorkerResponseFrames(preparePiWorkerResponse(input))];
		expect(frames.length).toBeGreaterThan(1);
		for (const frame of frames) {
			if (frame.kind !== "resultChunk") throw new Error("Expected a chunk");
			const appended = appendPiWorkerResponseChunk(accumulator, frame);
			if (appended.kind === "pending") accumulator = appended.accumulator;
			else result = appended.result;
		}
		expect(result).toEqual(input.result);
		expect(accumulator?.chunks).toEqual([]);
	});

	it.each([{ sequence: 1 }, { final: false, data: "too short" }, { data: "{invalid JSON" }])(
		"rejects invalid frame state: %j",
		(overrides) => {
			expect(() => appendPiWorkerResponseChunk(undefined, chunk(overrides))).toThrow();
		},
	);

	it("rejects aggregate overflow before retaining more data", () => {
		const accumulator = { nextSequence: 0, totalBytes: PI_WORKER_RESPONSE_MAX_BYTES, chunks: [] };
		expect(() => appendPiWorkerResponseChunk(accumulator, chunk())).toThrow("byte limit");
		expect(accumulator.chunks).toEqual([]);
	});

	it("rejects non-serializable results", () => {
		expect(() => preparePiWorkerResponse(response(undefined))).toThrow();
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => preparePiWorkerResponse(response(cyclic))).toThrow();
	});
});
