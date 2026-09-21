import { describe, expect, it } from "vitest";
import { PI_RETRY_BASE_DELAY_MS_MIN, PI_RETRY_MAX_RETRIES_MAX } from "./pi-settings";
import { createPiSettingsUpdateSchema } from "./pi-settings-requests";

const schema = createPiSettingsUpdateSchema();

describe("Pi settings write policy", () => {
	it("applies each retry field's own range instead of accepting the combined range", () => {
		expect(
			schema.safeParse({ type: "retryTuning", field: "maxRetries", value: PI_RETRY_MAX_RETRIES_MAX }).success,
		).toBe(true);
		expect(
			schema.safeParse({ type: "retryTuning", field: "baseDelayMs", value: PI_RETRY_BASE_DELAY_MS_MIN }).success,
		).toBe(true);
		expect(
			schema.safeParse({ type: "retryTuning", field: "maxRetries", value: PI_RETRY_MAX_RETRIES_MAX + 1 }).success,
		).toBe(false);
		expect(schema.safeParse({ type: "retryTuning", field: "maxAgentDelayMs", value: 0 }).success).toBe(true);
		expect(schema.safeParse({ type: "retryTuning", field: "baseDelayMs", value: 0 }).success).toBe(false);
		expect(schema.safeParse({ type: "retryTuning", field: "maxRetries", value: 60_000 }).success).toBe(false);
		expect(
			schema.safeParse({ type: "retryTuning", field: "baseDelayMs", value: PI_RETRY_BASE_DELAY_MS_MIN - 1 }).success,
		).toBe(false);
	});

	it("preserves the tool-set and shell-prefix rules previously enforced by the SDK settings owner", () => {
		expect(schema.safeParse({ type: "defaultTools", tools: [] }).success).toBe(true);
		expect(schema.safeParse({ type: "defaultTools", tools: ["read", "bash"] }).success).toBe(true);
		expect(schema.safeParse({ type: "defaultTools", tools: ["read", "read"] }).success).toBe(false);
		expect(schema.safeParse({ type: "shellCommandPrefix", prefix: null }).success).toBe(true);
		expect(schema.safeParse({ type: "shellCommandPrefix", prefix: "source env.sh\n" }).success).toBe(true);
		expect(schema.safeParse({ type: "shellCommandPrefix", prefix: "source\0env.sh" }).success).toBe(false);
	});
});
