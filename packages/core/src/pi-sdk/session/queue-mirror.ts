import { questionAnswerText } from "./question-answer-message";
import type { MessageFileReference } from "@ling/contracts/file-reference-text";
import { type SessionQueue, sessionImageMimeTypeSchema } from "@ling/contracts/session";
import { stripFileReferenceTargets } from "@ling/contracts/file-reference-text";
import { attemptCleanup, requestCapacityExceeded, throwAggregateFailures } from "../../ling-error";
import type { PiAgentSession, PiImageAttachment } from "../types";

export type PiQueueKind = "steering" | "followUp";

type PiAgent = Pick<
	PiAgentSession["agent"],
	"steer" | "followUp" | "clearSteeringQueue" | "clearFollowUpQueue" | "clearAllQueues" | "reset" | "subscribe"
>;
type QueueSession = Pick<
	PiAgentSession,
	"steer" | "followUp" | "clearQueue" | "getSteeringMessages" | "getFollowUpMessages"
> & { agent: PiAgent };
type PiQueuedMessage = Parameters<PiAgent["steer"]>[0];

/** One fully prepared multi-image message can approach 45M base64 chars; allow that,
 * but do not retain the same worst case dozens of times. */
const SESSION_QUEUE_MAX_RETAINED_CHARS = 64 * 1_024 * 1_024;

interface QueuedUserMessage {
	type: "user";
	text: string;
	draftText: string;
	images: readonly PiImageAttachment[];
	fileReferences: readonly MessageFileReference[];
}

interface QueuedMessageMetadata {
	draftText: string;
	fileReferences: readonly MessageFileReference[];
}

interface PendingQueueMetadata {
	kind: PiQueueKind;
	metadata: QueuedMessageMetadata;
	captured: boolean;
}

interface QueuedOpaqueMessage {
	type: "opaque";
	message: PiQueuedMessage;
}

type QueuedMessagePlan = QueuedUserMessage | QueuedOpaqueMessage;

interface QueuePlan {
	steering: QueuedMessagePlan[];
	followUp: QueuedMessagePlan[];
}

interface QueueFailure {
	kind: PiQueueKind;
	index: number;
	error: unknown;
}

type QueueMirrorInconsistentError = Error & {
	code: "QUEUE_MIRROR_INCONSISTENT";
};

function inconsistentQueueMirror(detail: string): QueueMirrorInconsistentError {
	return Object.assign(new Error(`Pi queue mirror is inconsistent: ${detail}`), {
		code: "QUEUE_MIRROR_INCONSISTENT" as const,
	});
}

function textAndImages(message: PiQueuedMessage): { text: string; images: PiImageAttachment[] } | null {
	if (message.role !== "user") return null;
	if (typeof message.content === "string") return { text: message.content, images: [] };

	const text: string[] = [];
	const images: PiImageAttachment[] = [];
	for (const part of message.content) {
		if (part.type === "text") text.push(part.text);
		else if (part.type === "image") images.push(part);
	}
	// Match Pi AgentSession._getUserMessageText(): queued text identity is the
	// concatenation of text blocks, without an inserted separator.
	return { text: text.join(""), images };
}

function queuedMessageRetainedChars(message: PiQueuedMessage): number {
	if (message.role !== "user") return questionAnswerText(message)?.length ?? 1_024;
	if (typeof message.content === "string") return message.content.length;
	let chars = 0;
	for (const part of message.content) {
		if (part.type === "text") chars += part.text.length;
		else if (part.type === "image") chars += part.data.length + part.mimeType.length;
	}
	return chars;
}

function toPlan(message: PiQueuedMessage, metadata?: QueuedMessageMetadata): QueuedMessagePlan {
	const user = textAndImages(message);
	return user
		? {
				type: "user",
				text: user.text,
				draftText: metadata?.draftText ?? user.text,
				images: user.images,
				fileReferences: metadata?.fileReferences ?? [],
			}
		: { type: "opaque", message };
}

function clonePlan(plan: QueuePlan): QueuePlan {
	return { steering: [...plan.steering], followUp: [...plan.followUp] };
}

function projectQuestionAnswer(message: PiQueuedMessage): SessionQueue["steering"] {
	const text = questionAnswerText(message);
	return text === null ? [] : [{ text, draftText: text, images: [], fileReferences: [], readOnly: true }];
}

function projectMessages(
	messages: readonly PiQueuedMessage[],
	metadataByMessage: WeakMap<object, QueuedMessageMetadata>,
): SessionQueue["steering"] {
	return messages.flatMap((message) => {
		const user = textAndImages(message);
		if (!user) return projectQuestionAnswer(message);
		const metadata = metadataByMessage.get(message);
		return [
			{
				text: user.text,
				draftText: metadata?.draftText ?? user.text,
				images: user.images.map(({ type, data, mimeType }) => ({
					type,
					data,
					mimeType: sessionImageMimeTypeSchema.parse(mimeType),
				})),
				fileReferences: metadata?.fileReferences.map((reference) => ({ ...reference })) ?? [],
			},
		];
	});
}

function projectPlan(entries: readonly QueuedMessagePlan[]): SessionQueue["steering"] {
	return entries.flatMap((entry) =>
		entry.type === "user"
			? [
					{
						text: entry.text,
						draftText: entry.draftText,
						images: entry.images.map(({ type, data, mimeType }) => ({
							type,
							data,
							mimeType: sessionImageMimeTypeSchema.parse(mimeType),
						})),
						fileReferences: entry.fileReferences.map((reference) => ({ ...reference })),
					},
				]
			: projectQuestionAnswer(entry.message),
	);
}

function visibleUserIndex(entries: readonly QueuedMessagePlan[], index: number, expectedText: string): number {
	let visibleIndex = 0;
	for (const [entryIndex, entry] of entries.entries()) {
		if (entry.type !== "user") {
			if (questionAnswerText(entry.message) === null) continue;
			if (visibleIndex === index) throw new Error("A submitted question answer cannot be edited as a queued draft");
			visibleIndex += 1;
			continue;
		}
		if (visibleIndex === index) {
			if (entry.text !== expectedText) {
				throw new Error(`Queued message at index ${index} changed since it was read`);
			}
			return entryIndex;
		}
		visibleIndex += 1;
	}
	throw new Error(`No queued message at index ${index}`);
}

function queueFailureLocations(failures: readonly QueueFailure[]): string {
	return failures.map(({ kind, index }) => `${kind}[${index}]`).join(", ");
}

function throwQueueRewriteFailure(
	applyFailures: readonly QueueFailure[],
	recoveryFailures: readonly QueueFailure[],
): never {
	if (recoveryFailures.length === 0) {
		if (applyFailures.length === 1) {
			const failure = applyFailures[0];
			if (!failure) throw new Error("Queue rewrite reported a missing failure");
			throw failure.error;
		}
		throw new AggregateError(
			applyFailures.map(({ error }) => error),
			`Queue rewrite failed at ${queueFailureLocations(applyFailures)}; the previous queue was restored`,
		);
	}
	throw new AggregateError(
		[...applyFailures, ...recoveryFailures].map(({ error }) => error),
		`Queue rewrite failed at ${queueFailureLocations(applyFailures)} and recovery failed at ${queueFailureLocations(recoveryFailures)}`,
	);
}

type QueueAgentMethod = "steer" | "followUp" | "clearSteeringQueue" | "clearFollowUpQueue" | "clearAllQueues" | "reset";

function restoreOwnedAgentMethod<Key extends QueueAgentMethod>(
	agent: PiAgent,
	key: Key,
	owned: PiAgent[Key],
	original: PiAgent[Key],
): void {
	if (agent[key] === owned) agent[key] = original;
}

/**
 * Mirrors Pi's full Agent queues at their public enqueue boundary. Pi's
 * `queue_update` event exposes text only, while the Agent queue also carries image
 * parts and extension custom messages; rebuilding from that event would silently
 * discard both.
 */
export class PiQueueMirror {
	private readonly agent: PiAgent;
	private readonly steering: PiQueuedMessage[] = [];
	private readonly followUp: PiQueuedMessage[] = [];
	private readonly captured = new WeakSet<object>();
	private readonly metadataByMessage = new WeakMap<object, QueuedMessageMetadata>();
	private readonly listeners = new Set<(queue: SessionQueue) => void>();
	private readonly unsubscribe: () => void;
	private readonly originalSteer: PiAgent["steer"];
	private readonly originalFollowUp: PiAgent["followUp"];
	private readonly originalClearSteeringQueue: PiAgent["clearSteeringQueue"];
	private readonly originalClearFollowUpQueue: PiAgent["clearFollowUpQueue"];
	private readonly originalClearAllQueues: PiAgent["clearAllQueues"];
	private readonly originalReset: PiAgent["reset"];
	private readonly wrappedSteer: PiAgent["steer"];
	private readonly wrappedFollowUp: PiAgent["followUp"];
	private readonly wrappedClearSteeringQueue: PiAgent["clearSteeringQueue"];
	private readonly wrappedClearFollowUpQueue: PiAgent["clearFollowUpQueue"];
	private readonly wrappedClearAllQueues: PiAgent["clearAllQueues"];
	private readonly wrappedReset: PiAgent["reset"];
	private disposed = false;
	private inconsistency: QueueMirrorInconsistentError | null = null;
	private pendingMetadata: PendingQueueMetadata | null = null;
	/**
	 * Queued messages held back from Pi while the current run is failing. Pi drains both
	 * queues into new runs right after a failed turn (agent-session._handlePostAgentRun →
	 * agent.continue()), which sends every queued message into a dead provider one by one.
	 * Parked entries still project as queued, edits apply to the parked plan, and they go
	 * back to Pi untouched once a retried attempt starts streaming again.
	 */
	private parked: QueuePlan | null = null;

	constructor(private readonly session: QueueSession) {
		this.agent = session.agent;
		this.originalSteer = this.agent.steer;
		this.originalFollowUp = this.agent.followUp;
		this.originalClearSteeringQueue = this.agent.clearSteeringQueue;
		this.originalClearFollowUpQueue = this.agent.clearFollowUpQueue;
		this.originalClearAllQueues = this.agent.clearAllQueues;
		this.originalReset = this.agent.reset;

		this.wrappedSteer = (message) => {
			this.assertQueueAdmission(message);
			this.originalSteer.call(this.agent, message);
			this.capture("steering", this.steering, message);
		};
		this.wrappedFollowUp = (message) => {
			this.assertQueueAdmission(message);
			this.originalFollowUp.call(this.agent, message);
			this.capture("followUp", this.followUp, message);
		};
		this.wrappedClearSteeringQueue = () => {
			this.originalClearSteeringQueue.call(this.agent);
			this.clearCaptured(this.steering);
		};
		this.wrappedClearFollowUpQueue = () => {
			this.originalClearFollowUpQueue.call(this.agent);
			this.clearCaptured(this.followUp);
		};
		this.wrappedClearAllQueues = () => {
			this.originalClearAllQueues.call(this.agent);
			this.clearCaptured(this.steering);
			this.clearCaptured(this.followUp);
		};
		this.wrappedReset = () => {
			this.originalReset.call(this.agent);
			this.clearCaptured(this.steering);
			this.clearCaptured(this.followUp);
		};

		this.unsubscribe = this.agent.subscribe((event) => {
			if (event.type !== "message_start" || !this.captured.has(event.message)) return;
			this.removeDelivered(event.message);
		});
		try {
			this.agent.steer = this.wrappedSteer;
			this.agent.followUp = this.wrappedFollowUp;
			this.agent.clearSteeringQueue = this.wrappedClearSteeringQueue;
			this.agent.clearFollowUpQueue = this.wrappedClearFollowUpQueue;
			this.agent.clearAllQueues = this.wrappedClearAllQueues;
			this.agent.reset = this.wrappedReset;
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	subscribe(listener: (queue: SessionQueue) => void): () => void {
		this.assertUsable();
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	project(): SessionQueue {
		this.assertUsable();
		if (this.parked) {
			return { revision: 0, steering: projectPlan(this.parked.steering), followUp: projectPlan(this.parked.followUp) };
		}
		return {
			revision: 0,
			steering: projectMessages(this.steering, this.metadataByMessage),
			followUp: projectMessages(this.followUp, this.metadataByMessage),
		};
	}

	/** Move Pi's queues into the parked plan so a failed turn cannot drain them; idempotent. */
	park(): void {
		if (this.disposed || this.parked) return;
		// Mirror-only plan: the Pi-visible-text assertion in snapshotPlan() would poison the
		// mirror on a transient divergence, and parking must never do that.
		const plan = this.mirroredPlan();
		if (plan.steering.length === 0 && plan.followUp.length === 0) return;
		this.parked = plan;
		// Clearing Pi's queue re-enters the wrapped clear, which emits; parked is already set,
		// so the projection the renderer sees does not flicker to empty.
		this.session.clearQueue();
	}

	/** Hand the parked plan back to Pi; entries that fail to enqueue stay parked. */
	async unpark(): Promise<void> {
		const plan = this.parked;
		if (this.disposed || !plan) return;
		this.parked = null;
		const failures = await this.enqueuePlan(plan);
		if (failures.length === 0) return;
		const failedIndexes = { steering: new Set<number>(), followUp: new Set<number>() };
		for (const failure of failures) failedIndexes[failure.kind].add(failure.index);
		this.parked = {
			steering: plan.steering.filter((_entry, index) => failedIndexes.steering.has(index)),
			followUp: plan.followUp.filter((_entry, index) => failedIndexes.followUp.has(index)),
		};
		this.emit();
	}

	/** Drop the parked plan and return its user messages (steering first) for the caller to restore. */
	takeParked(): SessionQueue["followUp"] {
		const plan = this.parked;
		if (!plan) return [];
		this.parked = null;
		const taken = [...projectPlan(plan.steering), ...projectPlan(plan.followUp)].filter((message) => !message.readOnly);
		this.emit();
		return taken;
	}

	enqueue(
		kind: PiQueueKind,
		text: string,
		images?: readonly PiImageAttachment[],
		fileReferences: readonly MessageFileReference[] = [],
	): Promise<void> {
		return this.enqueueUser(kind, text, images, {
			draftText: stripFileReferenceTargets(text, fileReferences),
			fileReferences: [...fileReferences],
		});
	}

	async edit(
		kind: PiQueueKind,
		index: number,
		expectedText: string,
		text: string | null,
		images?: readonly PiImageAttachment[],
		fileReferences?: readonly MessageFileReference[],
	): Promise<void> {
		const current = this.snapshotPlan();
		const next = clonePlan(current);
		const target = next[kind];
		const entryIndex = visibleUserIndex(target, index, expectedText);
		const entry = target[entryIndex];
		if (entry?.type !== "user") throw inconsistentQueueMirror("editable entry is missing");
		if (text === null) target.splice(entryIndex, 1);
		else {
			const nextFileReferences = fileReferences === undefined ? entry.fileReferences : [...fileReferences];
			target[entryIndex] = {
				...entry,
				text,
				draftText: stripFileReferenceTargets(text, nextFileReferences),
				fileReferences: nextFileReferences,
				...(images === undefined ? {} : { images: [...images] }),
			};
		}
		await this.rewrite(current, next);
	}

	/** Re-insert a message at the head of its queue (undo of a failed head promotion). */
	async restoreFront(
		kind: PiQueueKind,
		text: string,
		images?: readonly PiImageAttachment[],
		fileReferences: readonly MessageFileReference[] = [],
	): Promise<void> {
		const current = this.snapshotPlan();
		const next = clonePlan(current);
		next[kind].unshift({
			type: "user",
			text,
			draftText: stripFileReferenceTargets(text, fileReferences),
			images: images ? [...images] : [],
			fileReferences: [...fileReferences],
		});
		await this.rewrite(current, next);
	}

	async promote(index: number, expectedText: string): Promise<void> {
		const current = this.snapshotPlan();
		const next = clonePlan(current);
		const entryIndex = visibleUserIndex(next.followUp, index, expectedText);
		const [entry] = next.followUp.splice(entryIndex, 1);
		if (entry?.type !== "user") throw inconsistentQueueMirror("promoted entry is missing");
		next.steering.push(entry);
		await this.rewrite(current, next);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const failures: unknown[] = [];
		attemptCleanup(failures, this.unsubscribe);
		const methods: Array<[QueueAgentMethod, PiAgent[QueueAgentMethod], PiAgent[QueueAgentMethod]]> = [
			["steer", this.wrappedSteer, this.originalSteer],
			["followUp", this.wrappedFollowUp, this.originalFollowUp],
			["clearSteeringQueue", this.wrappedClearSteeringQueue, this.originalClearSteeringQueue],
			["clearFollowUpQueue", this.wrappedClearFollowUpQueue, this.originalClearFollowUpQueue],
			["clearAllQueues", this.wrappedClearAllQueues, this.originalClearAllQueues],
			["reset", this.wrappedReset, this.originalReset],
		];
		for (const [key, owned, original] of methods) {
			attemptCleanup(failures, () => restoreOwnedAgentMethod(this.agent, key, owned, original));
		}
		this.clearCaptured(this.steering);
		this.clearCaptured(this.followUp);
		this.listeners.clear();
		throwAggregateFailures(failures, "Failed to dispose the Pi queue mirror");
	}

	private emit(): void {
		if (this.disposed || this.listeners.size === 0) return;
		const queue = this.project();
		for (const listener of this.listeners) listener(queue);
	}

	private capture(kind: PiQueueKind, target: PiQueuedMessage[], message: PiQueuedMessage): void {
		if (this.disposed) return;
		target.push(message);
		this.captured.add(message);
		const pending = this.pendingMetadata;
		if (pending?.kind === kind && !pending.captured) {
			pending.captured = true;
			this.metadataByMessage.set(message, pending.metadata);
		}
		this.emit();
	}

	private assertQueueAdmission(message: PiQueuedMessage): void {
		this.assertUsable();
		const current = [...this.steering, ...this.followUp];
		let retainedChars = queuedMessageRetainedChars(message);
		for (const queued of current) {
			retainedChars += queuedMessageRetainedChars(queued);
			if (retainedChars > SESSION_QUEUE_MAX_RETAINED_CHARS) break;
		}
		if (retainedChars > SESSION_QUEUE_MAX_RETAINED_CHARS) {
			throw requestCapacityExceeded(
				"sessionQueuedMessageData",
				SESSION_QUEUE_MAX_RETAINED_CHARS,
				"The queued message data is too large. Remove or wait for an existing queued message before adding another.",
			);
		}
	}

	private clearCaptured(target: PiQueuedMessage[]): void {
		if (target.length === 0) return;
		for (const message of target) this.captured.delete(message);
		target.length = 0;
		this.emit();
	}

	private removeDelivered(message: PiQueuedMessage): void {
		const steeringIndex = this.steering.indexOf(message);
		if (steeringIndex >= 0) {
			this.steering.splice(steeringIndex, 1);
			this.captured.delete(message);
			this.emit();
			return;
		}
		const followUpIndex = this.followUp.indexOf(message);
		if (followUpIndex >= 0) {
			this.followUp.splice(followUpIndex, 1);
			this.captured.delete(message);
			this.emit();
			return;
		}
		this.inconsistency = inconsistentQueueMirror("a captured message was delivered twice or outside its queue");
	}

	private assertUsable(): void {
		if (this.disposed) throw inconsistentQueueMirror("mirror has been disposed");
		if (this.inconsistency) throw this.inconsistency;
	}

	private mirroredPlan(): QueuePlan {
		return {
			steering: this.steering.map((message) => toPlan(message, this.metadataByMessage.get(message as object))),
			followUp: this.followUp.map((message) => toPlan(message, this.metadataByMessage.get(message as object))),
		};
	}

	private snapshotPlan(): QueuePlan {
		this.assertUsable();
		if (this.parked) return clonePlan(this.parked);
		const plan = this.mirroredPlan();
		this.assertVisibleQueue("steering", plan.steering, this.session.getSteeringMessages());
		this.assertVisibleQueue("followUp", plan.followUp, this.session.getFollowUpMessages());
		return plan;
	}

	private assertVisibleQueue(
		kind: PiQueueKind,
		entries: readonly QueuedMessagePlan[],
		visibleTexts: readonly string[],
	): void {
		const mirroredTexts = entries.flatMap((entry) => (entry.type === "user" ? [entry.text] : []));
		if (
			mirroredTexts.length !== visibleTexts.length ||
			mirroredTexts.some((text, index) => text !== visibleTexts[index])
		) {
			this.inconsistency = inconsistentQueueMirror(`${kind} text snapshot diverged from the Agent queue`);
			throw this.inconsistency;
		}
	}

	private async rewrite(current: QueuePlan, next: QueuePlan): Promise<void> {
		this.assertUsable();
		if (this.parked) {
			this.parked = clonePlan(next);
			this.emit();
			return;
		}
		this.session.clearQueue();
		const applyFailures = await this.enqueuePlan(next);
		if (applyFailures.length === 0) return;

		try {
			this.session.clearQueue();
		} catch (recoveryClearError) {
			throw new AggregateError(
				[...applyFailures.map(({ error }) => error), recoveryClearError],
				`Queue rewrite failed at ${queueFailureLocations(applyFailures)} and the partial queue could not be cleared for recovery`,
			);
		}
		const recoveryFailures = await this.enqueuePlan(current);
		throwQueueRewriteFailure(applyFailures, recoveryFailures);
	}

	private async enqueuePlan(plan: QueuePlan): Promise<QueueFailure[]> {
		const failures: QueueFailure[] = [];
		await this.enqueueKind("steering", plan.steering, failures);
		await this.enqueueKind("followUp", plan.followUp, failures);
		return failures;
	}

	private async enqueueUser(
		kind: PiQueueKind,
		text: string,
		images: readonly PiImageAttachment[] | undefined,
		metadata: QueuedMessageMetadata,
	): Promise<void> {
		this.assertUsable();
		if (this.parked) {
			this.parked[kind].push({
				type: "user",
				text,
				draftText: metadata.draftText,
				images: images ? [...images] : [],
				fileReferences: [...metadata.fileReferences],
			});
			this.emit();
			return;
		}
		if (this.pendingMetadata) throw inconsistentQueueMirror("queue metadata enqueue overlapped");
		const pending: PendingQueueMetadata = { kind, metadata, captured: false };
		this.pendingMetadata = pending;
		try {
			if (kind === "steering") await this.session.steer(text, images ? [...images] : undefined);
			else await this.session.followUp(text, images ? [...images] : undefined);
			if (!pending.captured) throw inconsistentQueueMirror("queued message was not captured");
		} finally {
			if (this.pendingMetadata === pending) this.pendingMetadata = null;
		}
	}

	private async enqueueKind(
		kind: PiQueueKind,
		entries: readonly QueuedMessagePlan[],
		failures: QueueFailure[],
	): Promise<void> {
		for (const [index, entry] of entries.entries()) {
			try {
				if (entry.type === "user") {
					const images = entry.images.length > 0 ? [...entry.images] : undefined;
					await this.enqueueUser(kind, entry.text, images, {
						draftText: entry.draftText,
						fileReferences: entry.fileReferences,
					});
				} else if (kind === "steering") {
					this.agent.steer(entry.message);
				} else {
					this.agent.followUp(entry.message);
				}
			} catch (error) {
				failures.push({ kind, index, error });
			}
		}
	}
}
