import { describe, expect, it } from "vitest";
import { normalizePiMessage } from "./message-normalizer";

const options = { messageId: "live-1", entryId: "entry-1", occurredAt: 100 };

describe("Pi message normalization", () => {
	it("retains parent output and valid nested calls when another nested record is malformed", () => {
		const message = normalizePiMessage(
			{
				role: "toolResult",
				toolCallId: "outer",
				toolName: "codemode",
				isError: false,
				content: [{ type: "text", text: "completed output" }],
				nestedCalls: {
					complete: true,
					calls: [
						{ id: "good", name: "read", status: "ok", arguments: { path: "README.md" } },
						{ id: "bad", name: "read", status: "invalid" },
					],
				},
			},
			options,
		);
		expect(message).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "completed output" }],
			nestedCalls: { complete: false, calls: [{ id: "good" }] },
		});
	});

	it("marks nested arguments incomplete when a structural limit clips valid SDK arguments", () => {
		const message = normalizePiMessage(
			{
				role: "toolResult",
				toolCallId: "outer",
				toolName: "codemode",
				isError: false,
				content: [],
				nestedCalls: {
					complete: true,
					calls: [{ id: "child", name: "probe", status: "ok", arguments: { values: Array(600).fill(0) } }],
				},
			},
			options,
		);
		expect(message).toMatchObject({ role: "toolResult", nestedCalls: { complete: false } });
	});

	it("reserves nested metadata only for results that carry it", () => {
		const image = { type: "image", mimeType: "image/png", data: "A".repeat(5 * 1024 * 1024) };
		for (const value of [
			{ role: "user", content: [image] },
			{ role: "toolResult", toolCallId: "outer", toolName: "generate_image", isError: false, content: [image] },
		]) {
			expect(normalizePiMessage(value, { ...options, entryId: null })).toMatchObject({
				role: value.role,
				content: [{ type: "image", data: image.data }],
			});
		}
		const crowded = normalizePiMessage(
			{
				role: "toolResult",
				toolCallId: "outer",
				toolName: "codemode",
				isError: true,
				content: [image, { type: "text", text: "Completed with child failures" }],
				details: { text: "x".repeat(64 * 1024) },
				nestedCalls: {
					complete: true,
					calls: Array.from({ length: 256 }, (_, index) => ({
						id: String(index),
						name: "read",
						status: "error",
						error: "错".repeat(1024),
					})),
				},
			},
			{ ...options, entryId: null },
		);
		expect(crowded).toMatchObject({ role: "toolResult", nestedCalls: { complete: true } });
		expect(JSON.stringify(crowded)).toContain("Completed with child failures");
		expect(Buffer.byteLength(JSON.stringify(crowded), "utf8")).toBeLessThan(6 * 1024 * 1024);
	});

	it("retains nested Codemode calls and incomplete records in persisted tool results", () => {
		const nestedCalls = {
			complete: false,
			calls: [
				{ id: "child-1", name: "mcp_echo", status: "ok", arguments: { text: "hello" }, durationMs: 15 },
				{ id: "child-2", name: "bash", status: "error", error: "Permission denied" },
				{ id: "child-3", name: "read", status: "unfinished", argumentsBytes: 10000 },
			],
		};
		const message = normalizePiMessage(
			{
				role: "toolResult",
				toolCallId: "outer",
				toolName: "codemode",
				isError: false,
				content: [{ type: "text", text: "done" }],
				nestedCalls,
			},
			options,
		);
		expect(message).toMatchObject({ role: "toolResult", nestedCalls, entryId: "entry-1" });
		const bounded = normalizePiMessage(
			{
				role: "toolResult",
				toolCallId: "outer",
				toolName: "codemode",
				isError: false,
				content: [],
				nestedCalls: {
					complete: true,
					calls: Array.from({ length: 257 }, (_, index) => ({ id: String(index), name: "read", status: "ok" })),
				},
			},
			options,
		);
		if (bounded.role !== "toolResult") throw new Error("Expected a tool result");
		expect(bounded.nestedCalls?.calls).toHaveLength(256);
		expect(bounded.nestedCalls?.complete).toBe(false);
	});

	it("displays persisted images independently of provider size and format limits", () => {
		for (const mimeType of ["image/png", "image/avif", "image/svg+xml"]) {
			const message = normalizePiMessage(
				{ role: "user", content: [{ type: "image", mimeType, data: "A".repeat(6 * 1024 * 1024) }] },
				options,
			);
			expect(message).toMatchObject({
				content: [{ type: "image", mimeType, source: { entryId: "entry-1", index: 0 } }],
			});
			expect(JSON.stringify(message).length).toBeLessThan(512);
		}
	});
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
