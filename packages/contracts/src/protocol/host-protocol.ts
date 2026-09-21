import { z } from "zod";
import { appVersionSchema, type AppPlatform } from "../application";
import { ABSOLUTE_PATH_MAX_CHARS } from "../path-bounds";
import { PROJECT_FILE_REFERENCE_MAX_ITEMS } from "../project";
import { SESSION_IMAGE_MAX_ITEMS, SESSION_IMAGE_TOTAL_MAX_BYTES, SESSION_MESSAGE_TEXT_MAX_CHARS } from "../session";
import { lingErrorDtoSchema, type LingErrorDto } from "../ling-error";

/** Breaking generation of the client/host wire contract; incompatible peers must refuse to connect. */
export const HOST_PROTOCOL_VERSION = 5;
/** Maximum characters in a client or request id; bounds replay-cache keys and diagnostics. */
const HOST_PROTOCOL_ID_MAX_CHARS = 128;
/** Maximum characters in a method or event channel; bounds dispatch keys before domain parsing. */
const HOST_PROTOCOL_CHANNEL_MAX_CHARS = 160;
/** Maximum top-level arguments in one request; current LingApi methods use at most two. */
const HOST_PROTOCOL_ARGUMENT_MAX_ITEMS = 8;
/** Maximum authentication-token characters; accommodates 256-bit base64url tokens with rotation metadata. */
const HOST_PROTOCOL_TOKEN_MAX_CHARS = 256;
/** Maximum error-message characters returned over the wire; complete diagnostics remain in host logs. */
const HOST_PROTOCOL_ERROR_MAX_CHARS = 2_000;
/** Maximum response ids acknowledged in one frame; prevents an unbounded replay-cache deletion batch. */
const HOST_PROTOCOL_ACK_MAX_ITEMS = 256;
/** Pending request ids carried across reconnect; matches the Host's per-client active request ceiling. */
export const HOST_PROTOCOL_PENDING_REQUEST_CAPACITY = 256;
/** Include every file-reference path and cwd at worst-case JSON escaping, plus 64 KiB
 * for bounded identifiers, field names, positions and the request envelope. */
const HOST_REQUEST_METADATA_MAX_BYTES =
	(PROJECT_FILE_REFERENCE_MAX_ITEMS + 1) * ABSOLUTE_PATH_MAX_CHARS * 6 + 64 * 1_024;
/** Admit the full decoded image budget after base64/padding. Queue edits carry both old
 * and new text, each needing up to six JSON bytes per UTF-16 unit. Both peers share this bound. */
export const HOST_PROTOCOL_FRAME_MAX_BYTES =
	Math.ceil(SESSION_IMAGE_TOTAL_MAX_BYTES / 3) * 4 +
	SESSION_IMAGE_MAX_ITEMS * 4 +
	SESSION_MESSAGE_TEXT_MAX_CHARS * 12 +
	HOST_REQUEST_METADATA_MAX_BYTES;

const HOST_PRODUCT_KINDS = ["electron", "web"] as const;
export type HostProductKind = (typeof HOST_PRODUCT_KINDS)[number];

export interface HostEnvironment {
	appVersion: string;
	home: string | null;
	platform: AppPlatform;
}

type HostProtocolErrorCode =
	| "UNAUTHORIZED"
	| "ORIGIN_REJECTED"
	| "PROTOCOL_MISMATCH"
	| "INVALID_FRAME"
	| "UNKNOWN_METHOD"
	| "REQUEST_ID_CONFLICT"
	| "REQUEST_CAPACITY_EXCEEDED"
	| "INTERNAL_ERROR";

export interface HostProtocolError {
	code: HostProtocolErrorCode;
	message: string;
}

export type HostResponseError =
	{ kind: "protocol"; error: HostProtocolError } | { kind: "domain"; error: LingErrorDto };

export type HostClientFrame =
	| {
			kind: "hello";
			protocolVersion: number;
			clientId: string;
			product: HostProductKind;
			token: string;
			lastEventSequence: number | null;
			pendingRequestIds: string[];
	  }
	| { kind: "request"; id: string; method: string; args: unknown[] }
	| { kind: "ack"; eventSequence: number; requestIds: string[] }
	| { kind: "cancel"; id: string };

export type HostServerFrame =
	| {
			kind: "welcome";
			protocolVersion: number;
			hostId: string;
			eventSequence: number;
			resume: "fresh" | "resumed" | "reload-required";
			environment: HostEnvironment;
	  }
	| { kind: "response"; id: string; ok: true; result: unknown }
	| { kind: "response"; id: string; ok: false; error: HostResponseError }
	| { kind: "event"; sequence: number; channel: string; payload: unknown }
	| { kind: "fatal"; error: HostProtocolError };

const idSchema = z.string().min(1).max(HOST_PROTOCOL_ID_MAX_CHARS);
const channelSchema = z.string().min(1).max(HOST_PROTOCOL_CHANNEL_MAX_CHARS);
const sequenceSchema = z.number().int().nonnegative();
const protocolErrorSchema = z.strictObject({
	code: z.enum([
		"UNAUTHORIZED",
		"ORIGIN_REJECTED",
		"PROTOCOL_MISMATCH",
		"INVALID_FRAME",
		"UNKNOWN_METHOD",
		"REQUEST_ID_CONFLICT",
		"REQUEST_CAPACITY_EXCEEDED",
		"INTERNAL_ERROR",
	]),
	message: z.string().min(1).max(HOST_PROTOCOL_ERROR_MAX_CHARS),
});
const responseErrorSchema: z.ZodType<HostResponseError> = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("protocol"), error: protocolErrorSchema }),
	z.strictObject({ kind: z.literal("domain"), error: lingErrorDtoSchema }),
]);

const clientFrameSchema: z.ZodType<HostClientFrame> = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("hello"),
		protocolVersion: z.number().int().nonnegative(),
		clientId: idSchema,
		product: z.enum(HOST_PRODUCT_KINDS),
		token: z.string().min(1).max(HOST_PROTOCOL_TOKEN_MAX_CHARS),
		lastEventSequence: sequenceSchema.nullable(),
		pendingRequestIds: z.array(idSchema).max(HOST_PROTOCOL_PENDING_REQUEST_CAPACITY),
	}),
	z.strictObject({
		kind: z.literal("request"),
		id: idSchema,
		method: channelSchema,
		args: z.array(z.unknown()).max(HOST_PROTOCOL_ARGUMENT_MAX_ITEMS),
	}),
	z.strictObject({
		kind: z.literal("ack"),
		eventSequence: sequenceSchema,
		requestIds: z.array(idSchema).max(HOST_PROTOCOL_ACK_MAX_ITEMS),
	}),
	z.strictObject({ kind: z.literal("cancel"), id: idSchema }),
]);

const environmentSchema: z.ZodType<HostEnvironment> = z.strictObject({
	appVersion: appVersionSchema,
	home: z.string().nullable(),
	platform: z.enum(["darwin", "win32", "linux", "other"]),
});

const serverFrameSchema: z.ZodType<HostServerFrame> = z.union([
	z.strictObject({
		kind: z.literal("welcome"),
		protocolVersion: z.number().int().nonnegative(),
		hostId: idSchema,
		eventSequence: sequenceSchema,
		resume: z.enum(["fresh", "resumed", "reload-required"]),
		environment: environmentSchema,
	}),
	z.strictObject({ kind: z.literal("response"), id: idSchema, ok: z.literal(true), result: z.unknown() }),
	z.strictObject({ kind: z.literal("response"), id: idSchema, ok: z.literal(false), error: responseErrorSchema }),
	z.strictObject({
		kind: z.literal("event"),
		sequence: sequenceSchema,
		channel: channelSchema,
		payload: z.unknown(),
	}),
	z.strictObject({ kind: z.literal("fatal"), error: protocolErrorSchema }),
]);

export function parseHostClientFrame(value: unknown): HostClientFrame {
	return clientFrameSchema.parse(value);
}

export function parseHostServerFrame(value: unknown): HostServerFrame {
	return serverFrameSchema.parse(value);
}

const BYTE_MARKER = "$ling.bytes";
/** Bytes converted per String.fromCharCode call; larger spreads can exceed engine argument limits. */
const BASE64_BYTE_CHUNK_SIZE = 32 * 1_024;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_BYTE_CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_BYTE_CHUNK_SIZE));
	}
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function serializeHostFrame(frame: HostClientFrame | HostServerFrame): string {
	return JSON.stringify(frame, (_key, value: unknown) => {
		if (value instanceof Uint8Array) return { [BYTE_MARKER]: bytesToBase64(value) };
		return value;
	});
}

export function deserializeHostFrame(text: string): unknown {
	return JSON.parse(text, (_key, value: unknown) => {
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Object.keys(value).length === 1 &&
			BYTE_MARKER in value &&
			typeof (value as Record<string, unknown>)[BYTE_MARKER] === "string"
		) {
			return base64ToBytes((value as Record<string, string>)[BYTE_MARKER] as string);
		}
		return value;
	});
}
