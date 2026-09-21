import type { SessionRef } from "@ling/contracts/session";
import { lingErrorDtoSchema } from "@ling/contracts/ling-error";
import { assertJsonFrameSize } from "@ling/core/json-frame";
import { PI_WORKER_MAIN_METHODS } from "@ling/core/pi-protocol/callback-methods";
import { z } from "zod";
import { createLingError } from "../ling-error";
import {
	controlPathSchema as absolutePathSchema,
	controlIdSchema as identifierSchema,
	controlSessionRefSchema as sessionRefSchema,
} from "./control-schemas";
import { PI_WORKER_METHODS } from "./methods";
import { parsePiWorkerEventPayload } from "./payload-validation";
import type {
	PiWorkerCancel,
	PiWorkerControlFrame,
	PiWorkerErrorDto,
	PiWorkerEvent,
	PiWorkerMainCancel,
	PiWorkerMainRequest,
	PiWorkerMainResponse,
	PiWorkerParentMessage,
	PiWorkerRequest,
	PiWorkerResponseFrame,
} from "./protocol";
import { errorDetailsSchema } from "./runtime-payload-schemas";
import {
	PI_WORKER_EVENT_MAX_BYTES,
	PI_WORKER_PROTOCOL_VERSION,
	PI_WORKER_REQUEST_MAX_BYTES,
	PI_WORKER_RESPONSE_CHUNK_MAX_CHARS,
	PI_WORKER_RESPONSE_CHUNK_MAX_COUNT,
	PI_WORKER_RESPONSE_MAX_BYTES,
} from "./wire-format";

const ERROR_MESSAGE_MAX_CHARS = 16_384;

const generationSchema = z.number().int().positive();
const deadlineSchema = z.number().int().positive();
const methodSchema = z.enum(PI_WORKER_METHODS);
const mainMethodSchema = z.enum(PI_WORKER_MAIN_METHODS);

const errorSchema: z.ZodType<PiWorkerErrorDto> = z.strictObject({
	code: z.string().min(1).max(128),
	message: z.string().min(1).max(ERROR_MESSAGE_MAX_CHARS),
	retryable: z.boolean(),
	category: z.string().max(128).optional(),
	userAction: z.string().max(128).optional(),
	details: errorDetailsSchema.optional(),
});

const requestSchema: z.ZodType<PiWorkerRequest> = z.strictObject({
	kind: z.literal("request"),
	protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
	generation: generationSchema,
	requestId: identifierSchema,
	method: methodSchema,
	deadlineAt: deadlineSchema,
	params: z.unknown(),
});

const responseSchema: z.ZodType<PiWorkerResponseFrame> = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("result"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		requestId: identifierSchema,
		method: methodSchema,
		result: z.unknown(),
	}),
	z.strictObject({
		kind: z.literal("error"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		requestId: identifierSchema,
		method: methodSchema,
		error: errorSchema,
	}),
	z.strictObject({
		kind: z.literal("resultChunk"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		requestId: identifierSchema,
		method: methodSchema,
		sequence: z
			.number()
			.int()
			.nonnegative()
			.max(PI_WORKER_RESPONSE_CHUNK_MAX_COUNT - 1),
		final: z.boolean(),
		data: z.string().min(1).max(PI_WORKER_RESPONSE_CHUNK_MAX_CHARS),
	}),
]);

const mainRequestSchema: z.ZodType<PiWorkerMainRequest> = z.strictObject({
	kind: z.literal("mainRequest"),
	protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
	generation: generationSchema,
	requestId: identifierSchema,
	method: mainMethodSchema,
	deadlineAt: deadlineSchema.nullable(),
	params: z.unknown(),
});

const mainResponseSchema: z.ZodType<PiWorkerMainResponse> = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("mainResult"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		requestId: identifierSchema,
		method: mainMethodSchema,
		result: z.unknown(),
	}),
	z.strictObject({
		kind: z.literal("mainError"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		requestId: identifierSchema,
		method: mainMethodSchema,
		error: errorSchema,
	}),
]);

const cancelSchema: z.ZodType<PiWorkerCancel | PiWorkerMainCancel> = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("cancel"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		requestId: identifierSchema,
	}),
	z.strictObject({
		kind: z.literal("mainCancel"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		requestId: identifierSchema,
	}),
]);

const parentMessageSchema: z.ZodType<PiWorkerParentMessage> = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("attachControl"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		systemProxyFallback: z.string().max(4_096).nullable(),
	}),
	z.strictObject({
		kind: z.literal("ping"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		sentAt: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("pong"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
		sentAt: z.number().int().nonnegative(),
		heapUsedBytes: z.number().int().nonnegative(),
		heapLimitBytes: z.number().int().positive(),
		eventLoopDelayMs: z.number().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("shutdown"),
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: generationSchema,
	}),
]);

const readySchema = z.strictObject({
	kind: z.literal("ready"),
	protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
	generation: generationSchema,
	pid: z.number().int().positive(),
	piVersion: z.string().min(1).max(256),
});

const shutdownSchema = z.strictObject({
	kind: z.enum(["shutdown", "shutdownComplete"]),
	protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
	generation: generationSchema,
});

export function parsePiWorkerRequest(value: unknown): PiWorkerRequest {
	assertJsonFrameSize(value, PI_WORKER_REQUEST_MAX_BYTES, "Pi worker request");
	return requestSchema.parse(value);
}

export function parsePiWorkerResponse(value: unknown): PiWorkerResponseFrame {
	assertJsonFrameSize(value, PI_WORKER_RESPONSE_MAX_BYTES, "Pi worker response");
	return responseSchema.parse(value);
}

export function parsePiWorkerMainRequest(value: unknown): PiWorkerMainRequest {
	assertJsonFrameSize(value, PI_WORKER_REQUEST_MAX_BYTES, "Pi worker main request");
	return mainRequestSchema.parse(value);
}

export function parsePiWorkerMainResponse(value: unknown): PiWorkerMainResponse {
	assertJsonFrameSize(value, PI_WORKER_RESPONSE_MAX_BYTES, "Pi worker main response");
	return mainResponseSchema.parse(value);
}

export function parsePiWorkerCancel(value: unknown): PiWorkerCancel | PiWorkerMainCancel {
	assertJsonFrameSize(value, 4 * 1024, "Pi worker cancellation");
	return cancelSchema.parse(value);
}

export function parsePiWorkerParentMessage(value: unknown): PiWorkerParentMessage {
	assertJsonFrameSize(value, 8 * 1024, "Pi worker parent message");
	return parentMessageSchema.parse(value);
}

export function parsePiWorkerReady(value: unknown): Extract<PiWorkerControlFrame, { kind: "ready" }> {
	assertJsonFrameSize(value, 4 * 1024, "Pi worker ready frame");
	return readySchema.parse(value);
}

export function parsePiWorkerShutdownFrame(
	value: unknown,
): Extract<PiWorkerControlFrame, { kind: "shutdown" | "shutdownComplete" }> {
	assertJsonFrameSize(value, 4 * 1024, "Pi worker shutdown frame");
	return shutdownSchema.parse(value);
}

export function parsePiWorkerEvent(value: unknown): PiWorkerEvent {
	assertJsonFrameSize(value, PI_WORKER_EVENT_MAX_BYTES, "Pi worker event");
	return parsePiWorkerEventPayload(value);
}

export function parsePiWorkerRuntimeId(value: unknown): string {
	return identifierSchema.parse(value);
}

export function parsePiWorkerSessionRef(value: unknown): SessionRef {
	return sessionRefSchema.parse(value);
}

export function parsePiWorkerAbsolutePath(value: unknown): string {
	return absolutePathSchema.parse(value);
}

export function piWorkerErrorDto(error: unknown, fallbackCode = "PI_HOST_OPERATION_FAILED"): PiWorkerErrorDto {
	const normalizedFallbackCode = fallbackCode.slice(0, 128) || "PI_HOST_OPERATION_FAILED";
	let candidate: Error | null = null;
	try {
		if (error instanceof Error) candidate = error;
	} catch {
		// A proxy can throw from instanceof. It is projected through the scalar fallback below.
	}
	if (candidate) {
		const read = (key: string): unknown => {
			try {
				return Reflect.get(candidate, key);
			} catch {
				return undefined;
			}
		};
		const boundary = lingErrorDtoSchema.safeParse(read("lingError"));
		if (boundary.success) {
			const { causeId: _causeId, ...dto } = boundary.data;
			return dto;
		}
		const code = read("code");
		const message = read("message");
		const retryable = read("retryable");
		const category = read("category");
		const userAction = read("userAction");
		const dto: PiWorkerErrorDto = {
			code: typeof code === "string" ? code.slice(0, 128) || normalizedFallbackCode : normalizedFallbackCode,
			message:
				typeof message === "string"
					? message.slice(0, ERROR_MESSAGE_MAX_CHARS) || normalizedFallbackCode
					: normalizedFallbackCode,
			retryable: typeof retryable === "boolean" ? retryable : false,
		};
		if (typeof category === "string") dto.category = category.slice(0, 128);
		if (typeof userAction === "string") dto.userAction = userAction.slice(0, 128);
		const details = errorDetailsSchema.safeParse(read("details"));
		if (details.success) {
			try {
				dto.details = structuredClone(details.data);
			} catch {
				// Invalid custom error metadata must not hide the useful code and message.
			}
		}
		return dto;
	}
	let message = normalizedFallbackCode;
	try {
		message = String(error).slice(0, ERROR_MESSAGE_MAX_CHARS) || normalizedFallbackCode;
	} catch {
		// Keep the stable fallback for values whose string coercion throws.
	}
	return { code: normalizedFallbackCode, message, retryable: false };
}

export function piWorkerError(error: PiWorkerErrorDto): Error {
	const boundary = lingErrorDtoSchema.safeParse(error);
	if (boundary.success) return createLingError(boundary.data);
	return Object.assign(new Error(error.message), {
		code: error.code,
		retryable: error.retryable,
		...(error.category === undefined ? {} : { category: error.category }),
		...(error.userAction === undefined ? {} : { userAction: error.userAction }),
		...(error.details === undefined ? {} : { details: error.details }),
	});
}
