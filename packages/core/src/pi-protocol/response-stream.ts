import { Buffer } from "node:buffer";
import type { PiWorkerResponse, PiWorkerResponseChunk, PiWorkerResponseFrame } from "./protocol";
import {
	PI_WORKER_PROTOCOL_VERSION,
	PI_WORKER_RESPONSE_CHUNK_MAX_CHARS,
	PI_WORKER_RESPONSE_CHUNK_MAX_COUNT,
	PI_WORKER_RESPONSE_MAX_BYTES,
} from "./wire-format";

type PreparedPiWorkerResponse =
	| { kind: "single"; frame: PiWorkerResponse }
	| {
			kind: "stream";
			generation: number;
			requestId: string;
			method: PiWorkerResponseChunk["method"];
			serializedResult: string;
			chunkCount: number;
	  };

export interface PiWorkerResponseChunkAccumulator {
	nextSequence: number;
	totalBytes: number;
	chunks: string[];
}

type PiWorkerResponseChunkAppendResult =
	{ kind: "pending"; accumulator: PiWorkerResponseChunkAccumulator } | { kind: "complete"; result: unknown };

function responseStreamError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code, retryable: false, category: "transport" });
}

export function preparePiWorkerResponse(response: PiWorkerResponse): PreparedPiWorkerResponse {
	if (response.kind === "error") return { kind: "single", frame: response };
	let serializedResult: string | undefined;
	try {
		serializedResult = JSON.stringify(response.result);
	} catch (error) {
		throw responseStreamError(
			"PI_HOST_RESPONSE_INVALID",
			`Pi worker response is not JSON-safe: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serializedResult === undefined) {
		throw responseStreamError("PI_HOST_RESPONSE_INVALID", "Pi worker response cannot encode an undefined result");
	}
	if (serializedResult.length <= PI_WORKER_RESPONSE_CHUNK_MAX_CHARS) {
		return { kind: "single", frame: response };
	}
	const serializedBytes = Buffer.byteLength(serializedResult, "utf8");
	if (serializedBytes > PI_WORKER_RESPONSE_MAX_BYTES) {
		throw responseStreamError(
			"PI_HOST_RESPONSE_TOO_LARGE",
			`Pi worker response exceeds the ${PI_WORKER_RESPONSE_MAX_BYTES}-byte stream limit`,
		);
	}
	return {
		kind: "stream",
		generation: response.generation,
		requestId: response.requestId,
		method: response.method,
		serializedResult,
		chunkCount: Math.ceil(serializedResult.length / PI_WORKER_RESPONSE_CHUNK_MAX_CHARS),
	};
}

export function* iteratePiWorkerResponseFrames(prepared: PreparedPiWorkerResponse): Generator<PiWorkerResponseFrame> {
	if (prepared.kind === "single") {
		yield prepared.frame;
		return;
	}
	for (let sequence = 0; sequence < prepared.chunkCount; sequence += 1) {
		const offset = sequence * PI_WORKER_RESPONSE_CHUNK_MAX_CHARS;
		yield {
			kind: "resultChunk",
			protocolVersion: PI_WORKER_PROTOCOL_VERSION,
			generation: prepared.generation,
			requestId: prepared.requestId,
			method: prepared.method,
			sequence,
			final: sequence === prepared.chunkCount - 1,
			data: prepared.serializedResult.slice(offset, offset + PI_WORKER_RESPONSE_CHUNK_MAX_CHARS),
		};
	}
}

export function appendPiWorkerResponseChunk(
	current: PiWorkerResponseChunkAccumulator | undefined,
	chunk: PiWorkerResponseChunk,
): PiWorkerResponseChunkAppendResult {
	const accumulator = current ?? { nextSequence: 0, totalBytes: 0, chunks: [] };
	if (chunk.sequence !== accumulator.nextSequence) {
		throw new Error(`Pi worker response chunk sequence mismatch: expected ${accumulator.nextSequence}`);
	}
	if (!chunk.final && chunk.data.length !== PI_WORKER_RESPONSE_CHUNK_MAX_CHARS) {
		throw new Error("Pi worker non-final response chunk has an invalid length");
	}
	const totalBytes = accumulator.totalBytes + Buffer.byteLength(chunk.data, "utf8");
	if (totalBytes > PI_WORKER_RESPONSE_MAX_BYTES) {
		throw new Error("Pi worker response stream exceeds its aggregate byte limit");
	}
	accumulator.chunks.push(chunk.data);
	accumulator.totalBytes = totalBytes;
	accumulator.nextSequence += 1;
	if (!chunk.final) {
		if (accumulator.nextSequence >= PI_WORKER_RESPONSE_CHUNK_MAX_COUNT) {
			throw new Error("Pi worker response stream exceeds its chunk-count limit");
		}
		return { kind: "pending", accumulator };
	}
	const serializedResult = accumulator.chunks.join("");
	accumulator.chunks.length = 0;
	try {
		return { kind: "complete", result: JSON.parse(serializedResult) as unknown };
	} catch (error) {
		throw new Error("Pi worker response stream contains invalid JSON", { cause: error });
	}
}
