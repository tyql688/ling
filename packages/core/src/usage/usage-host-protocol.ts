import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import { usageRangeDaysSchema, type UsageRangeDays, type UsageStatsSnapshot } from "@ling/contracts/usage";
import { assertJsonFrameSize } from "@ling/core/json-frame";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const USAGE_HOST_PROTOCOL_VERSION = 2 as const;

const USAGE_HOST_REQUEST_MAX_BYTES = 8 * 1024;
export const USAGE_HOST_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const USAGE_MODEL_ID_MAX_CHARS = 4_096;
const USAGE_MODEL_KEY_MAX_CHARS = 8_192;
/** Upper bound for the all-time day series; ~27 years of daily rows, far beyond real Pi histories. */
const USAGE_DAYS_MAX_ITEMS = 10_000;
const USAGE_MODEL_MAX_ITEMS = 10_000;

export interface UsageHostRequest {
	kind: "request";
	protocolVersion: 2;
	method: "getStats";
	rangeDays: UsageRangeDays;
	agentDir: string;
	deadlineAt: number;
}

export interface UsageHostErrorDto {
	code: "INVALID_REQUEST" | "REQUEST_DEADLINE_EXCEEDED" | "USAGE_SCAN_FAILED";
	message: string;
	retryable: boolean;
}

export type UsageHostResponse =
	| {
			kind: "result";
			protocolVersion: 2;
			method: "getStats";
			result: UsageStatsSnapshot;
	  }
	| {
			kind: "error";
			protocolVersion: 2;
			method: "getStats";
			error: UsageHostErrorDto;
	  };

const requestSchema: z.ZodType<UsageHostRequest> = z.strictObject({
	kind: z.literal("request"),
	protocolVersion: z.literal(USAGE_HOST_PROTOCOL_VERSION),
	method: z.literal("getStats"),
	rangeDays: usageRangeDaysSchema,
	agentDir: z
		.string()
		.min(1)
		.max(ABSOLUTE_PATH_MAX_CHARS)
		.refine((value) => isAbsolute(value), "Usage host agentDir must be absolute"),
	deadlineAt: z.number().int().positive(),
});

const safeCountSchema = z.number().int().nonnegative();
const costSchema = z.number().nonnegative();
const modelIdSchema = z.string().max(USAGE_MODEL_ID_MAX_CHARS);
const modelKeySchema = z.string().max(USAGE_MODEL_KEY_MAX_CHARS);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

const usageSnapshotSchema: z.ZodType<UsageStatsSnapshot> = z.strictObject({
	rangeDays: usageRangeDaysSchema,
	skippedFileCount: safeCountSchema,
	totalTokens: safeCountSchema,
	sessionCount: safeCountSchema,
	userMessageCount: safeCountSchema,
	activeDays: safeCountSchema,
	currentStreak: safeCountSchema,
	models: z
		.array(
			z.strictObject({
				provider: modelIdSchema,
				model: modelIdSchema,
				totalTokens: safeCountSchema,
				assistantMessages: safeCountSchema,
			}),
		)
		.max(USAGE_MODEL_MAX_ITEMS),
	days: z
		.array(
			z.strictObject({
				date: dateSchema,
				totalTokens: safeCountSchema,
				inputTokens: safeCountSchema,
				outputTokens: safeCountSchema,
				cacheReadTokens: safeCountSchema,
				cacheWriteTokens: safeCountSchema,
				cost: costSchema,
				byModel: z.record(modelKeySchema, safeCountSchema),
			}),
		)
		.max(USAGE_DAYS_MAX_ITEMS),
	heatmap: z
		.array(
			z.strictObject({
				date: dateSchema,
				totalTokens: safeCountSchema,
				active: z.boolean(),
			}),
		)
		.max(371),
	paletteOrder: z.array(modelKeySchema).max(USAGE_MODEL_MAX_ITEMS),
});

const errorSchema: z.ZodType<UsageHostErrorDto> = z.strictObject({
	code: z.enum(["INVALID_REQUEST", "REQUEST_DEADLINE_EXCEEDED", "USAGE_SCAN_FAILED"]),
	message: z.string().min(1).max(2_000),
	retryable: z.boolean(),
});

const responseSchema: z.ZodType<UsageHostResponse> = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("result"),
		protocolVersion: z.literal(USAGE_HOST_PROTOCOL_VERSION),
		method: z.literal("getStats"),
		result: usageSnapshotSchema,
	}),
	z.strictObject({
		kind: z.literal("error"),
		protocolVersion: z.literal(USAGE_HOST_PROTOCOL_VERSION),
		method: z.literal("getStats"),
		error: errorSchema,
	}),
]);

export function parseUsageHostRequest(value: unknown): UsageHostRequest {
	assertJsonFrameSize(value, USAGE_HOST_REQUEST_MAX_BYTES, "Usage host request");
	return requestSchema.parse(value);
}

export function parseUsageHostResponse(value: unknown): UsageHostResponse {
	assertJsonFrameSize(value, USAGE_HOST_RESPONSE_MAX_BYTES, "Usage host response");
	return responseSchema.parse(value);
}
