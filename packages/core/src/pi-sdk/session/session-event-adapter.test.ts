import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { LingSessionEvent } from "@ling/contracts/session";
import { expect, it } from "vitest";
import type { PiAgentSession } from "../types";
import { createPiSessionEventAdapter } from "./session-event-adapter";
import { projectPiBranchMessages, summarizePiBranchMessages } from "./session-message-projector";

it("keeps retained live message identities distinct after replacing the event subscription", async () => {
	const sessionManager = SessionManager.inMemory("/project");
	const session = {
		sessionManager,
		extensionRunner: { getMarkdownTransformers: () => [] },
	} as unknown as PiAgentSession;
	const retainedIds = new Set<string>();
	for (let subscription = 0; subscription < 2; subscription++) {
		const deferred: LingSessionEvent[] = [];
		const adapter = createPiSessionEventAdapter({
			session,
			onDeferredEvent: (event) => deferred.push(event),
			getMarkdownWidth: () => 88,
			queueMirror: () => {
				throw new Error("User message projection does not access the model queue");
			},
		});
		try {
			for (let turn = 0; turn < 2; turn++) {
				const message = { role: "user" as const, content: `Subscription ${subscription}, turn ${turn}`, timestamp: 1 };
				const started = adapter.adapt({ type: "message_start", message });
				if (started?.type !== "messageStart") throw new Error("Expected messageStart");
				expect(retainedIds.has(started.message.id)).toBe(false);
				retainedIds.add(started.message.id);
				const ended = adapter.adapt({ type: "message_end", message });
				expect(ended).toMatchObject({ type: "messageEnd", message: { id: started.message.id } });
				const entryId = sessionManager.appendMessage(message);
				await new Promise<void>((resolve) => queueMicrotask(resolve));
				expect(deferred.at(-1)).toEqual({ type: "messagePersisted", messageId: started.message.id, entryId });
			}
		} finally {
			adapter.dispose();
		}
	}
});

it("retains SDK system entries without turning prompt/tool metadata into live or replayed chat rows", async () => {
	const sessionManager = SessionManager.inMemory("/project");
	const session = { sessionManager } as PiAgentSession;
	const deferred: LingSessionEvent[] = [];
	const adapter = createPiSessionEventAdapter({
		session,
		onDeferredEvent: (event) => deferred.push(event),
		getMarkdownWidth: () => 88,
		queueMirror: () => {
			throw new Error("System metadata must not change the user queue");
		},
	});
	try {
		const system = {
			role: "system" as const,
			content: "Private model instructions",
			toolsRemoved: [{ name: "write" }],
			timestamp: 1,
		};
		expect(adapter.adapt({ type: "message_start", message: system })).toBeNull();
		expect(adapter.adapt({ type: "message_end", message: system })).toBeNull();
		sessionManager.appendMessage(system);
		const userId = sessionManager.appendMessage({ role: "user", content: "Visible question", timestamp: 2 });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(deferred).toEqual([]);
		expect(sessionManager.getBranch()).toHaveLength(2);
		expect(projectPiBranchMessages({ sessionManager, extensions: null })).toMatchObject([
			{ role: "user", id: `entry:${userId}` },
		]);
		expect(summarizePiBranchMessages(session)).toEqual({ messageCount: 1, preview: "Visible question" });
	} finally {
		adapter.dispose();
	}
});
