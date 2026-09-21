import type { SessionEventEnvelope, SessionMessage, SessionSnapshot, TranscriptPage } from "@ling/contracts/session";
import {
	emptySessionTranscriptState,
	emptySessionView,
	sessionViewFamily,
	sessionBusyFamily,
	sessionMessagesFamily,
} from "@renderer/features/sessions/state/session";
import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { applyTranscriptTail, mergeHistoricalTranscriptPages } from "./session-transcript-projection";
import { reduceSessionView } from "./session-view";
import type { AssistantSessionMessage } from "@ling/contracts/session-messages";
import {
	applySessionMessageDelta,
	createSessionMessageDelta,
	SessionMessageDeltaMismatch,
} from "@ling/contracts/session-message-delta";

const user = (id: string, entryId: string | null = id): Extract<SessionMessage, { role: "user" }> => ({
	role: "user",
	id,
	entryId,
	occurredAt: 1,
	content: id,
});

describe("session view ownership", () => {
	it("replays deltas over a snapshot without duplicating text and rejects missing or rewritten baselines", () => {
		const first: AssistantSessionMessage = {
			role: "assistant",
			id: "assistant",
			entryId: null,
			occurredAt: 1,
			content: [{ type: "text", text: "a" }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		};
		const next: AssistantSessionMessage = { ...first, occurredAt: 2, content: [{ type: "text", text: "a😀文字" }] };
		const delta = createSessionMessageDelta(first, next);
		if (!delta) throw new Error("Expected append-only text");
		expect(applySessionMessageDelta(first, delta)).toEqual(next);
		expect(applySessionMessageDelta(next, delta)).toEqual(next);
		expect(applySessionMessageDelta({ ...first, content: [{ type: "text", text: "a😀" }] }, delta)).toEqual(next);
		expect(() => applySessionMessageDelta(undefined, delta)).toThrow(SessionMessageDeltaMismatch);
		expect(() => applySessionMessageDelta({ ...first, content: [{ type: "text", text: "" }] }, delta)).toThrow(
			SessionMessageDeltaMismatch,
		);
		expect(() => applySessionMessageDelta({ ...first, content: [{ type: "text", text: "a重写" }] }, delta)).toThrow(
			SessionMessageDeltaMismatch,
		);
		expect(createSessionMessageDelta(next, first)).toBeNull();
		expect(createSessionMessageDelta(first, { ...next, usage: { ...next.usage, output: 1 } })).toBeNull();
	});
	it("publishes messages and revisions together without notifying unrelated field subscribers", () => {
		const key = "session-view-atomic";
		const store = createStore();
		const view = sessionViewFamily(key);
		const observed: Array<{ count: number; revision: number }> = [];
		let busyNotifications = 0;
		const releaseView = store.sub(view, () => {
			const current = store.get(view);
			observed.push({ count: current.messages.length, revision: current.transcript.currentRevision });
		});
		const releaseBusy = store.sub(sessionBusyFamily(key), () => busyNotifications++);
		try {
			store.set(view, { ...emptySessionView(), transcript: state() });
			observed.length = 0;
			const envelope: SessionEventEnvelope = {
				protocolVersion: 1,
				ref: { cwd: "/project", sessionId: "session" },
				runtimeId: "runtime",
				generation: 1,
				sequence: 1,
				stateRevision: 1,
				transcriptRevision: 3,
				occurredAt: 1,
				deliveryClass: "snapshotRecoverable",
				event: { type: "messageUpdate", message: user("stream", null) },
			};
			store.set(view, (current) => reduceSessionView(current, { type: "event", envelope }));
			expect(observed).toEqual([{ count: 1, revision: 3 }]);
			expect(busyNotifications).toBe(0);
			expect(store.get(sessionMessagesFamily(key))).toBe(store.get(view).messages);
			store.set(sessionBusyFamily(key), true);
			expect(store.get(view).busy).toBe(true);
			expect(busyNotifications).toBe(1);
		} finally {
			releaseView();
			releaseBusy();
			sessionViewFamily.remove(key);
		}
	});

	it("retains durable history through rollover and snapshot reconciliation", () => {
		const initial = {
			...emptySessionView(7),
			messages: [user("older"), user("pending", null)],
			transcript: { ...state(), epoch: 7 },
		};
		const rolled = reduceSessionView(initial, { type: "rollover" });
		expect(rolled.messages).toBe(initial.messages);
		expect(rolled.transcript).toMatchObject({ epoch: 8, hasOlder: true, hydrationSettled: true, runtimeId: null });
		const snapshot: SessionSnapshot = {
			protocolVersion: 1,
			runtimeId: "next",
			generation: 2,
			ref: { cwd: "/project", sessionId: "session" },
			lastSequence: 1,
			stateRevision: 1,
			transcriptRevision: 2,
			transcriptCacheKey: "cache",
			commandCatalogRevision: 1,
			extensionUiRevision: 1,
			lifecycle: "active",
			toolExecutions: [],
			transcriptTail: page([user("tail")], { runtimeId: "next", generation: 2 }),
			busy: false,
			summarizationRetry: null,
			autoRetry: null,
			queue: { revision: 2, steering: [], followUp: [] },
			diagnostics: [],
		};
		const next = reduceSessionView(rolled, { type: "snapshot", snapshot });
		expect(next.messages.map((message) => message.id)).toEqual(["older", "tail"]);
		expect(next.transcript).toMatchObject({ runtimeId: "next", generation: 2, transcriptCacheKey: "cache" });
		expect(next.queue).toBe(snapshot.queue);
	});

	it("separates resync, hibernation, and identity eviction without leaving runtime state behind", () => {
		const initial = {
			...emptySessionView(3),
			messages: [user("saved")],
			transcript: { ...state(), epoch: 3 },
			busy: true,
			error: true,
			errorMessage: "failure",
		};
		const cleared = reduceSessionView(initial, { type: "clear" });
		expect(cleared).toMatchObject({
			messages: [],
			busy: false,
			error: true,
			errorMessage: "failure",
			transcript: { epoch: 4 },
		});
		const dormant = reduceSessionView(initial, { type: "hibernate", preserveTranscript: true });
		expect(dormant.messages).toBe(initial.messages);
		expect(dormant).toMatchObject({
			busy: false,
			error: false,
			errorMessage: null,
			transcript: { runtimeId: null, generation: 0 },
		});
		expect(reduceSessionView(dormant, { type: "evict" })).toEqual(emptySessionView(4));
	});
});
const page = (items: SessionMessage[], overrides: Partial<TranscriptPage> = {}): TranscriptPage => ({
	protocolVersion: 1,
	ref: { cwd: "/project", sessionId: "session" },
	hasNewer: false,
	runtimeId: "runtime",
	generation: 1,
	transcriptRevision: 2,
	items,
	hasOlder: true,
	olderCursor: "older",
	limit: 20,
	...overrides,
});
const state = () => ({
	...emptySessionTranscriptState(),
	runtimeId: "runtime",
	generation: 1,
	currentRevision: 2,
	chainRevision: 2,
	hasOlder: true,
	hydrationSettled: true,
});

describe("transcript projection", () => {
	it("restores branch order when a reload snapshot arrives after live messages", () => {
		const messages = [user("live-answer", "answer"), user("live-question", "question")];
		const merged = applyTranscriptTail(
			messages,
			state(),
			page([user("opening"), user("question"), user("answer")], { hasOlder: false }),
		);
		expect(merged.messages.map((message) => message.id)).toEqual(["opening", "live-question", "live-answer"]);
		expect(applyTranscriptTail(merged.messages, merged.state, page([user("answer")])).messages).toEqual(
			merged.messages,
		);
	});

	it("places a disjoint durable tail before an unpersisted live suffix", () => {
		const merged = applyTranscriptTail([user("older"), user("streaming", null)], state(), page([user("missed")]));
		expect(merged.messages.map((message) => message.id)).toEqual(["older", "missed", "streaming"]);
	});

	it("fills overlapping history in branch order without replacing live content", () => {
		const current = [user("old"), { ...user("live-now", "now"), content: "current content" }, user("live", null)];
		const merged = mergeHistoricalTranscriptPages(current, state(), [
			page([user("old"), user("missing"), user("disk-now", "now")]),
		]);
		expect(merged?.map((message) => message.id)).toEqual(["old", "missing", "live-now", "live"]);
		expect(merged?.[2]).toBe(current[1]);
	});

	it("keeps loaded tool bodies when a later tail carries a deferred stub", () => {
		const loaded: SessionMessage = {
			role: "toolResult",
			id: "tool-live",
			entryId: "tool-entry",
			occurredAt: 1,
			content: [{ type: "text", text: "loaded result" }],
			toolCallId: "call",
			toolName: "read",
			isError: false,
		};
		const stub: SessionMessage = { ...loaded, id: "tool-disk", contentState: "deferred", content: [] };
		const merged = applyTranscriptTail([user("live", null), loaded], state(), page([stub]));
		expect(merged.messages).toHaveLength(2);
		expect(merged.messages[0]).toEqual(user("live", null));
		expect(merged.messages[1]).toMatchObject({ content: [{ type: "text", text: "loaded result" }] });
	});

	it("drops non-durable messages on runtime rollover and preserves loaded history", () => {
		const merged = applyTranscriptTail(
			[user("old"), user("transient", null)],
			state(),
			page([user("new")], { runtimeId: "replacement", generation: 2 }),
		);
		expect(merged.messages.map((message) => message.id)).toEqual(["old", "new"]);
		expect(merged.state.hydrationSettled).toBe(true);
	});

	it("orders older pages before current live content and deduplicates durable identities", () => {
		const current = [user("now"), user("live", null)];
		const merged = mergeHistoricalTranscriptPages(current, state(), [
			page([user("middle"), user("disk-now", "now")]),
			page([user("old")]),
		]);
		expect(merged?.map((message) => message.id)).toEqual(["old", "middle", "now", "live"]);
	});

	it.each([{ generation: 2 }, { runtimeId: "foreign" }, { transcriptRevision: 3 }])(
		"rejects stale or foreign page binding: %j",
		(overrides) => {
			expect(mergeHistoricalTranscriptPages([user("now")], state(), [page([user("old")], overrides)])).toBeNull();
		},
	);

	it("keeps prior read failures during the same hydration attempt", () => {
		const current = { ...state(), historyError: "read failed" };
		expect(applyTranscriptTail([user("now")], current, page([user("now")])).state.historyError).toBe("read failed");
		expect(
			applyTranscriptTail([user("now")], current, page([user("now")], { hasOlder: false })).state.historyError,
		).toBeNull();
	});
});
