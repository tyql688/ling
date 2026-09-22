import { withTurnFolds } from "./turn-folds";
import type { AssistantSessionMessage, SessionMessage } from "@ling/contracts/session-messages";
import { describe, expect, it } from "vitest";
import {
	buildResultIndex,
	buildRows,
	buildRowsSeedFromMessages,
	timelineRowDisplayRevision,
} from "./transcript-activity-model";

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
		expect(rows.map((row) => row.kind)).toEqual(["plain", "activity"]);
		const activity = rows[1];
		if (activity?.kind !== "activity") throw new Error("Expected activity row");
		expect(activity.items.map((item) => item.type)).toEqual(["thinking", "text", "step", "text"]);
		expect(activity.items[2]).toEqual({ type: "step", step: { call, result } });
		expect(activity.terminalReply).toMatchObject({ messageId: "message:reply", index: 3 });
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

	it("keeps current work open as intermediate prose streams and returns to tool execution", () => {
		const work = assistant("work", [
			{ type: "text", text: "Checking the first file." },
			{ type: "toolCall", id: "first", name: "read", arguments: { path: "first.txt" } },
		]);
		const reply = assistant("progress", [{ type: "text", text: "The first check passed. Checking the next file." }]);
		delete reply.stopReason;
		const nextCall = assistant("progress", [
			...reply.content,
			{ type: "toolCall", id: "next", name: "read", arguments: { path: "next.txt" } },
		]);
		const previousTurn = [user, assistant("old-work", [{ type: "thinking", thinking: "Earlier work" }])];
		const currentUser = { ...user, id: "current-user", entryId: "current-user" };
		for (const tail of [[], [reply], [nextCall]]) {
			const messages = [...previousTurn, currentUser, work, ...tail];
			const rows = buildRows(messages, buildResultIndex(messages), true);
			const activities = rows.filter((row) => row.kind === "activity");
			expect(activities).toMatchObject([
				{ turnActive: false, running: false },
				{ turnActive: true, running: true },
			]);
		}

		const messages = [currentUser, work, reply];
		const resultIndex = buildResultIndex(messages);
		const active = buildRows(messages, resultIndex, true).find((row) => row.kind === "activity");
		const settled = buildRows(messages, resultIndex, false).find((row) => row.kind === "activity");
		if (!active || !settled) throw new Error("Expected work rows before and after settlement");
		expect(active).toMatchObject({ running: true, turnActive: true });
		expect(settled).toMatchObject({ running: false, turnActive: false });
		const options = { toolsExpanded: false, hiddenThinkingLabel: null, editingUserRowId: null };
		expect(timelineRowDisplayRevision(active, options)).not.toBe(timelineRowDisplayRevision(settled, options));
	});

	it("keeps streamed prose in the same item through tool calls, settlement and fold changes", () => {
		const thinking = { type: "thinking", thinking: "Checking the files" } as const;
		const text = { type: "text", text: "The first check passed. I will inspect the next file." } as const;
		const call = { type: "toolCall", id: "next", name: "read", arguments: { path: "next.txt" } } as const;
		const streaming = assistant("progress", [thinking, text], "stop");
		const calling = assistant("progress", [thinking, text, call], "stop");
		const toolUse = { ...calling, stopReason: "toolUse" };
		for (const message of [streaming, calling, toolUse]) {
			const messages = [user, message];
			const rows = buildRows(messages, buildResultIndex(messages), true);
			expect(rows.map((row) => row.kind)).toEqual(["plain", "activity"]);
			const activity = rows[1];
			if (activity?.kind !== "activity") throw new Error("Expected live work row");
			expect(activity.keyId).toBe("message:progress");
			expect(activity.items[1]).toMatchObject({ type: "text", text: text.text, revisionSources: [text] });
		}
		const finalReply = assistant("final", [{ type: "text", text: "All checks passed." }], "stop");
		const messages = [user, toolUse, finalReply];
		const live = buildRows(messages, buildResultIndex(messages), true);
		expect(live).toHaveLength(2);
		const settled = buildRows(messages, buildResultIndex(messages), false);
		const activity = settled[1];
		if (activity?.kind !== "activity") throw new Error("Expected settled work row");
		expect(activity).toMatchObject({
			keyId: "message:progress",
			terminalReply: { messageId: "message:final", message: finalReply },
		});
		expect(activity.items).toEqual(live[1]?.kind === "activity" ? live[1].items : undefined);
		for (const expanded of [false, true]) {
			const folded = withTurnFolds(settled, {
				busy: false,
				expandedTurnKeys: new Set(expanded ? ["message:user"] : []),
				messages,
			});
			expect(folded.map((row) => row.kind)).toEqual(["plain", "turnFold", "activity"]);
			expect(folded.at(-1)).toMatchObject({
				keyId: activity.keyId,
				items: activity.items,
				terminalReply: activity.terminalReply,
				turnFoldState: expanded ? "expanded" : "collapsed",
			});
		}
	});

	it("keeps adjacent replies distinct and avoids a work fold for a text-only answer", () => {
		const progress = assistant("progress", [{ type: "text", text: "Checking." }]);
		const reply = assistant("reply", [{ type: "text", text: "Done." }], "stop");
		const messages = [user, progress, reply];
		const rows = buildRows(messages, new Map(), false);
		expect(rows[1]).toMatchObject({
			items: [
				{ type: "text", messageId: "message:progress", text: "Checking." },
				{ type: "text", messageId: "message:reply", text: "Done." },
			],
		});
		const answerOnly = [user, reply];
		expect(
			withTurnFolds(buildRows(answerOnly, new Map(), false), {
				busy: false,
				expandedTurnKeys: new Set(),
				messages: answerOnly,
			}).map((row) => row.kind),
		).toEqual(["plain", "activity"]);
	});

	it("marks only the current work row busy and carries user ordinals across pages", () => {
		const messages = [assistant("work", [{ type: "thinking", thinking: "working" }])];
		const rows = buildRows(messages, new Map(), true, { indexOffset: 5, seed: buildRowsSeedFromMessages([user]) });
		expect(rows).toMatchObject([{ kind: "activity", running: true, turnActive: true, startTs: 1 }]);
		const reply = assistant("reply", [{ type: "text", text: "done" }], "stop");
		expect(
			buildRows([reply], new Map(), false, { indexOffset: 5, seed: buildRowsSeedFromMessages([user]) }),
		).toMatchObject([{ kind: "activity", terminalReply: { index: 5, message: reply } }]);
		expect(
			buildRows([user], new Map(), false, { indexOffset: 5, seed: buildRowsSeedFromMessages([user]) }),
		).toMatchObject([{ kind: "plain", index: 5, userMessageOrdinal: 1 }]);
	});

	it("preserves stopped replies and clears turn failure after a successful retry", () => {
		const failed = { ...assistant("failure", [], "error"), errorMessage: "Temporary error" };
		for (const stopReason of ["stop", "aborted"]) {
			const reply = assistant("reply", [{ type: "text", text: "Partial or completed answer" }], stopReason);
			const messages = [user, failed, reply];
			const folded = withTurnFolds(buildRows(messages, new Map(), false), {
				busy: false,
				expandedTurnKeys: new Set(),
				messages,
			});
			expect(folded[1]).toMatchObject({
				kind: "turnFold",
				outcome: stopReason === "aborted" ? "stopped" : "completed",
				failure: null,
				retryEntryId: null,
			});
			expect(folded[2]).toMatchObject({ kind: "activity", terminalReply: { message: reply } });
		}
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
