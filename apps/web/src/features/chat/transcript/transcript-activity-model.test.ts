import { withTurnFolds } from "./turn-folds";
import type { AssistantSessionMessage, SessionMessage } from "@ling/contracts/session-messages";
import { describe, expect, it } from "vitest";
import { buildResultIndex, buildRows, buildRowsSeedFromMessages } from "./transcript-activity-model";

const user: SessionMessage = {
	role: "user",
	id: "user",
	entryId: "user",
	occurredAt: 1,
	timestamp: 1,
	content: "question",
};
function assistant(
	id: string,
	content: AssistantSessionMessage["content"],
	stopReason = "toolUse",
): AssistantSessionMessage {
	return {
		role: "assistant",
		id,
		entryId: id,
		occurredAt: 2,
		timestamp: 2,
		content,
		stopReason,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	};
}

describe("timeline folds", () => {
	it("keeps a later extension message visible without extending the settled turn's duration", () => {
		const notification: SessionMessage = {
			role: "custom",
			id: "notification",
			entryId: "notification",
			occurredAt: 60_000,
			timestamp: 60_000,
			customType: "extension-command-result",
			content: "Command completed",
			display: true,
		};
		const messages = [
			user,
			assistant("work", [{ type: "thinking", thinking: "working" }]),
			assistant("reply", [{ type: "text", text: "answer" }], "stop"),
			notification,
		];
		const rows = withTurnFolds(buildRows(messages, buildResultIndex(messages), false), {
			busy: false,
			expandedTurnKeys: new Set(),
			messages,
		});
		expect(rows.at(-1)).toMatchObject({ kind: "plain", message: notification });
		expect(rows).toContainEqual(expect.objectContaining({ kind: "turnFold", durationMs: 1, hiddenCount: 1 }));
	});

	it("groups thinking, tool preamble and matching result in one work row", () => {
		const call = { type: "toolCall", id: "call", name: "read", arguments: { path: "file" } } as const;
		const result: SessionMessage = {
			role: "toolResult",
			id: "result",
			entryId: "result",
			occurredAt: 3,
			timestamp: 3,
			toolCallId: "call",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "contents" }],
		};
		const messages = [
			user,
			assistant("work", [{ type: "thinking", thinking: "think" }, { type: "text", text: "reading" }, call]),
			result,
			assistant("reply", [{ type: "text", text: "answer" }], "stop"),
		];
		const rows = buildRows(messages, buildResultIndex(messages), false);
		expect(rows.map((row) => row.kind)).toEqual(["plain", "activity", "plain"]);
		const activity = rows[1];
		if (activity?.kind !== "activity") throw new Error("Expected activity row");
		expect(activity.items.map((item) => item.type)).toEqual(["thinking", "text", "step"]);
		expect(activity.items[2]).toEqual({ type: "step", step: { call, result } });
		expect(activity.running).toBe(false);
	});

	it("preserves orphan results and unknown roles as visible rows", () => {
		const messages: SessionMessage[] = [
			{
				role: "toolResult",
				id: "orphan",
				entryId: "orphan",
				occurredAt: 1,
				content: [],
				toolCallId: "missing",
				toolName: "custom",
				isError: true,
			},
			{
				role: "unknown",
				originalRole: "future",
				data: { value: "message" },
				id: "unknown",
				entryId: null,
				occurredAt: 2,
			},
		];
		expect(buildRows(messages, buildResultIndex(messages), false)).toMatchObject([
			{ kind: "plain", message: messages[0] },
			{ kind: "plain", message: messages[1] },
		]);
	});

	it("marks only the current work row busy and carries user ordinals across pages", () => {
		const messages = [assistant("work", [{ type: "thinking", thinking: "working" }])];
		const rows = buildRows(messages, new Map(), true, { indexOffset: 5, seed: buildRowsSeedFromMessages([user]) });
		expect(rows).toMatchObject([{ kind: "activity", running: true, startTs: 1 }]);
		const reply = assistant("reply", [{ type: "text", text: "done" }], "stop");
		expect(
			buildRows([reply], new Map(), false, { indexOffset: 5, seed: buildRowsSeedFromMessages([user]) }),
		).toMatchObject([{ kind: "plain", index: 5, userMessageOrdinal: 0 }]);
	});
	it("keeps a failed turn's cause visible and retries only the latest durable user message", () => {
		const failed = { ...assistant("failure", [], "error"), errorMessage: "Rate limit reached" };
		const messages = [user, failed];
		const fold = withTurnFolds(buildRows(messages, buildResultIndex(messages), false), {
			busy: false,
			expandedTurnKeys: new Set(),
			messages,
		});
		expect(fold).toContainEqual(
			expect.objectContaining({
				kind: "turnFold",
				outcome: "failed",
				failure: "Rate limit reached",
				retryEntryId: "user",
			}),
		);
		const later = [
			...messages,
			{ ...user, id: "later", entryId: "later" },
			assistant("done", [{ type: "text", text: "done" }], "stop"),
		];
		const history = withTurnFolds(buildRows(later, buildResultIndex(later), false), {
			busy: false,
			expandedTurnKeys: new Set(),
			messages: later,
		});
		expect(history).toContainEqual(
			expect.objectContaining({ kind: "turnFold", outcome: "failed", retryEntryId: null }),
		);
		expect(
			withTurnFolds(buildRows(messages, buildResultIndex(messages), true), {
				busy: true,
				expandedTurnKeys: new Set(),
				messages,
			}).some((row) => row.kind === "turnFold"),
		).toBe(false);
	});
});
