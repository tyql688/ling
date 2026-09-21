import { describe, expect, it } from "vitest";
import { normalizePiMessage } from "./message-normalizer";

const options = { messageId: "live-1", entryId: "entry-1", occurredAt: 100 };

describe("Pi message normalization", () => {
	it("keeps durable identity and unknown future roles visible", () => {
		const message = normalizePiMessage({ role: "futureRole", content: "payload" }, options);
		expect(message).toMatchObject({
			role: "unknown",
			originalRole: "futureRole",
			id: "live-1",
			entryId: "entry-1",
			occurredAt: 100,
		});
	});

	it("retains text and points persisted images at their durable entry", () => {
		const message = normalizePiMessage(
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
			},
			options,
		);
		expect(message).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", mimeType: "image/png", source: { entryId: "entry-1", index: 1 } },
			],
		});
		expect(JSON.stringify(message)).not.toContain("aGVsbG8=");
	});

	it("keeps unpersisted image bytes until a durable entry exists", () => {
		expect(
			normalizePiMessage(
				{ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
				{ ...options, entryId: null },
			),
		).toMatchObject({ content: [{ data: "aGVsbG8=" }] });
	});

	it("bounds cyclic and deeply nested extension metadata without losing the role", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const message = normalizePiMessage(
			{ role: "custom", customType: "extension", content: "body", display: true, details: cyclic },
			options,
		);
		expect(message.role).toBe("custom");
		expect(JSON.stringify(message)).toContain("[circular]");
	});

	it("projects only a matching visible question answer as a user reply with its durable identity", () => {
		const reply = {
			role: "custom",
			customType: "ling-answer:questions:request",
			display: true,
			content: "Scope\n\nOnly docs",
			details: { feature: "questions", requestId: "request" },
		};
		expect(normalizePiMessage(reply, options)).toMatchObject({
			role: "user",
			id: "live-1",
			entryId: "entry-1",
			content: reply.content,
		});
		for (const changed of [
			{ details: undefined },
			{ details: { feature: "other", requestId: "request" } },
			{ display: false },
			{ customType: "another-extension" },
		]) {
			expect(normalizePiMessage({ ...reply, ...changed }, options).role).toBe("custom");
		}
	});

	it("truncates large text and leaves a visible marker", () => {
		// Cross the normalized string limit while staying far below the message byte budget.
		const message = normalizePiMessage({ role: "user", content: "x".repeat(70_000) }, options);
		expect(JSON.stringify(message)).toContain("[truncated]");
		expect(JSON.stringify(message).length).toBeLessThan(70_000);
	});

	it.each([NaN, Infinity, -1, 0.5])("rejects invalid observation time %s", (occurredAt) => {
		expect(() => normalizePiMessage({ role: "user", content: "body" }, { ...options, occurredAt })).toThrow();
	});
});
