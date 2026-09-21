import { describe, expect, it } from "vitest";
import { PiQueueMirror } from "./queue-mirror";

type QueueSession = ConstructorParameters<typeof PiQueueMirror>[0];
type Message = Parameters<QueueSession["agent"]["steer"]>[0];
function setup() {
	const steering: Message[] = [];
	const followUp: Message[] = [];
	const listeners = new Set<Parameters<QueueSession["agent"]["subscribe"]>[0]>();
	const text = (message: Message) =>
		message.role === "user"
			? typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("")
			: "";
	const session: QueueSession = {
		agent: {
			steer: (message) => {
				steering.push(message);
			},
			followUp: (message) => {
				followUp.push(message);
			},
			clearSteeringQueue: () => {
				steering.length = 0;
			},
			clearFollowUpQueue: () => {
				followUp.length = 0;
			},
			clearAllQueues: () => {
				steering.length = 0;
				followUp.length = 0;
			},
			reset: () => {
				steering.length = 0;
				followUp.length = 0;
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		steer: (text, images = []) => {
			session.agent.steer({ role: "user", content: [{ type: "text", text }, ...images], timestamp: 1 });
			return Promise.resolve();
		},
		followUp: (text, images = []) => {
			session.agent.followUp({ role: "user", content: [{ type: "text", text }, ...images], timestamp: 1 });
			return Promise.resolve();
		},
		getSteeringMessages: () => steering.filter((message) => message.role === "user").map(text),
		getFollowUpMessages: () => followUp.filter((message) => message.role === "user").map(text),
		clearQueue: () => {
			const result = { steering: steering.map(text), followUp: followUp.map(text) };
			session.agent.clearAllQueues();
			return result;
		},
	};
	const originalSteer = session.agent.steer;
	return { session, steering, followUp, listeners, originalSteer, mirror: new PiQueueMirror(session) };
}

describe("Pi queue mirror", () => {
	it("shows pending question answers without losing their envelope or shifting editable queue indexes", async () => {
		const h = setup();
		const answer: Message = {
			role: "custom",
			customType: "ling-answer:questions:one",
			display: true,
			content: "Only docs",
			details: { feature: "questions", requestId: "one" },
			timestamp: 1,
		};
		try {
			h.session.agent.steer(answer);
			await h.mirror.enqueue("steering", "next");
			expect(h.mirror.project().steering).toMatchObject([{ text: "Only docs", readOnly: true }, { text: "next" }]);
			await expect(h.mirror.edit("steering", 0, "Only docs", "other")).rejects.toThrow("cannot be edited");
			await h.mirror.edit("steering", 1, "next", "changed");
			expect(h.steering[0]).toBe(answer);
			h.mirror.park();
			expect(h.mirror.project().steering).toMatchObject([{ text: "Only docs", readOnly: true }, { text: "changed" }]);
			await h.mirror.unpark();
			expect(h.steering[0]).toBe(answer);
			for (const listener of h.listeners)
				await listener({ type: "message_start", message: answer }, new AbortController().signal);
			expect(h.mirror.project().steering.map((message) => message.text)).toEqual(["changed"]);
		} finally {
			h.mirror.dispose();
		}
	});

	it("preserves inline reference placement through parking and queue edits", async () => {
		const h = setup();
		const references = [{ scope: "project", path: "a.ts", textOffset: 7 }] as const;
		await h.mirror.enqueue("followUp", "before @a.ts after", [], references);
		expect(h.mirror.project().followUp[0]).toMatchObject({ draftText: "before  after", fileReferences: references });
		h.mirror.park();
		await h.mirror.unpark();
		await h.mirror.edit(
			"followUp",
			0,
			"before @a.ts after",
			"new @a.ts end",
			[],
			[{ ...references[0], textOffset: 4 }],
		);
		expect(h.mirror.project().followUp[0]).toMatchObject({
			text: "new @a.ts end",
			draftText: "new  end",
			fileReferences: [{ ...references[0], textOffset: 4 }],
		});
		h.mirror.dispose();
	});
	it("parks and restores both queues with image content intact", async () => {
		const h = setup();
		await h.mirror.enqueue("steering", "first", [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		await h.mirror.enqueue("followUp", "second");
		const before = h.mirror.project();
		h.mirror.park();
		h.mirror.park();
		expect(h.steering).toEqual([]);
		expect(h.followUp).toEqual([]);
		expect(h.mirror.project()).toEqual(before);
		await h.mirror.unpark();
		await h.mirror.unpark();
		expect(h.mirror.project()).toEqual(before);
		expect(h.steering).toHaveLength(1);
		expect(h.followUp).toHaveLength(1);
		h.mirror.dispose();
		expect(h.listeners.size).toBe(0);
		expect(h.session.agent.steer).toBe(h.originalSteer);
	});

	it("retains edits and new messages while parked without submitting them to Pi", async () => {
		const h = setup();
		await h.mirror.enqueue("steering", "first");
		h.mirror.park();
		await h.mirror.edit("steering", 0, "first", "edited");
		await h.mirror.enqueue("followUp", "later");
		expect(h.steering).toEqual([]);
		expect(h.followUp).toEqual([]);
		expect(h.mirror.takeParked().map((message) => message.text)).toEqual(["edited", "later"]);
		expect(h.mirror.takeParked()).toEqual([]);
		h.mirror.dispose();
	});

	it("retains failed unparks so they can be retried", async () => {
		const h = setup();
		await h.mirror.enqueue("steering", "first");
		h.mirror.park();
		const original = h.session.steer;
		h.session.steer = () => Promise.reject(new Error("enqueue failed"));
		await h.mirror.unpark();
		expect(h.mirror.project().steering.map((message) => message.text)).toEqual(["first"]);
		h.session.steer = original;
		await h.mirror.unpark();
		expect(h.steering).toHaveLength(1);
		h.mirror.dispose();
	});
});
