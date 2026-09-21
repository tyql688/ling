import type { SessionEventEnvelope, SessionSnapshot } from "@ling/contracts/session";
import { sessionEventPolicy } from "@ling/contracts/session-event-policy";

/**
 * Max events buffered while no snapshot is ready. 512 ≈ the upper bound of one dense tool
 * stream: larger just prolongs the "poisoned buffer → repeated resync" cycle; smaller drops
 * events after a normal blip and forces a screen clear. Overflow clears the buffer and
 * demands a resync with clearProjection, preventing unbounded buildup.
 */
const MAX_BUFFERED_EVENTS = 512;

interface SessionStreamPosition {
	runtimeId: string;
	generation: number;
	lastSequence: number;
	stateRevision: number;
	transcriptRevision: number;
	commandCatalogRevision: number;
	extensionUiRevision: number;
}

type SessionStreamResyncReason =
	"uninitialized" | "runtimeChanged" | "sequenceGap" | "revisionMismatch" | "invalidDeliveryClass" | "bufferOverflow";

type SessionEnvelopeDecision =
	| { type: "apply"; envelope: SessionEventEnvelope }
	| { type: "ignore" }
	| { type: "resync"; reason: SessionStreamResyncReason; clearProjection: boolean };

type SessionSnapshotDecision =
	{ type: "apply"; snapshot: SessionSnapshot; bufferedEvents: SessionEventEnvelope[] } | { type: "ignore" };

interface ControllerEntry {
	position: SessionStreamPosition | null;
	buffer: SessionEventEnvelope[];
}

interface SessionStreamController {
	acceptEnvelope(key: string, envelope: SessionEventEnvelope): SessionEnvelopeDecision;
	acceptSnapshot(key: string, snapshot: SessionSnapshot): SessionSnapshotDecision;
	getPosition(key: string): SessionStreamPosition | null;
	getEntryCount(): number;
	reset(key: string): void;
}

function positionFromSnapshot(snapshot: SessionSnapshot): SessionStreamPosition {
	return {
		runtimeId: snapshot.runtimeId,
		generation: snapshot.generation,
		lastSequence: snapshot.lastSequence,
		stateRevision: snapshot.stateRevision,
		transcriptRevision: snapshot.transcriptRevision,
		commandCatalogRevision: snapshot.commandCatalogRevision,
		extensionUiRevision: snapshot.extensionUiRevision,
	};
}

function expectedPosition(
	current: SessionStreamPosition,
	envelope: SessionEventEnvelope,
): SessionStreamPosition | null {
	const policy = sessionEventPolicy(envelope.event);
	if (envelope.deliveryClass !== policy.deliveryClass) return null;
	const stateRevision = current.stateRevision + (policy.stateEffect ? 1 : 0);
	const transcriptRevision = current.transcriptRevision + (policy.transcriptEffect ? 1 : 0);
	if (envelope.stateRevision !== stateRevision || envelope.transcriptRevision !== transcriptRevision) return null;
	let commandCatalogRevision = current.commandCatalogRevision;
	let extensionUiRevision = current.extensionUiRevision;
	if (envelope.event.type === "commandsChanged") {
		if (envelope.event.revision !== commandCatalogRevision + 1) return null;
		commandCatalogRevision = envelope.event.revision;
	}
	if (envelope.event.type === "extensionUiChanged") {
		if (envelope.event.revision !== extensionUiRevision + 1) return null;
		extensionUiRevision = envelope.event.revision;
	}
	return {
		runtimeId: current.runtimeId,
		generation: current.generation,
		lastSequence: envelope.sequence,
		stateRevision,
		transcriptRevision,
		commandCatalogRevision,
		extensionUiRevision,
	};
}

function sameBinding(position: SessionStreamPosition, envelope: SessionEventEnvelope): boolean {
	return position.runtimeId === envelope.runtimeId && position.generation === envelope.generation;
}

function createSessionStreamController(): SessionStreamController {
	const entries = new Map<string, ControllerEntry>();

	function entryFor(key: string): ControllerEntry {
		const existing = entries.get(key);
		if (existing) return existing;
		const created: ControllerEntry = { position: null, buffer: [] };
		entries.set(key, created);
		return created;
	}

	function bufferForResync(
		entry: ControllerEntry,
		envelope: SessionEventEnvelope,
		reason: SessionStreamResyncReason,
	): SessionEnvelopeDecision {
		entry.position = null;
		entry.buffer.push(envelope);
		if (entry.buffer.length > MAX_BUFFERED_EVENTS) {
			entry.buffer = [];
			return { type: "resync", reason: "bufferOverflow", clearProjection: true };
		}
		return { type: "resync", reason, clearProjection: reason !== "uninitialized" };
	}

	return {
		acceptEnvelope(key, envelope) {
			const entry = entryFor(key);
			const policy = sessionEventPolicy(envelope.event);
			if (envelope.deliveryClass !== policy.deliveryClass) {
				return bufferForResync(entry, envelope, "invalidDeliveryClass");
			}
			const position = entry.position;
			if (!position) return bufferForResync(entry, envelope, "uninitialized");
			if (position.runtimeId !== envelope.runtimeId) {
				entry.buffer = [];
				return bufferForResync(entry, envelope, "runtimeChanged");
			}
			if (envelope.generation < position.generation) return { type: "ignore" };
			if (envelope.generation > position.generation) {
				entry.buffer = [];
				return bufferForResync(entry, envelope, "runtimeChanged");
			}
			if (envelope.sequence <= position.lastSequence) return { type: "ignore" };
			if (envelope.sequence !== position.lastSequence + 1) {
				entry.buffer = [];
				return bufferForResync(entry, envelope, "sequenceGap");
			}
			const next = expectedPosition(position, envelope);
			if (!next) {
				entry.buffer = [];
				return bufferForResync(entry, envelope, "revisionMismatch");
			}
			entry.position = next;
			return { type: "apply", envelope };
		},
		acceptSnapshot(key, snapshot) {
			const entry = entryFor(key);
			const current = entry.position;
			if (current) {
				if (current.runtimeId === snapshot.runtimeId && snapshot.generation < current.generation) {
					return { type: "ignore" };
				}
				if (
					current.runtimeId === snapshot.runtimeId &&
					current.generation === snapshot.generation &&
					snapshot.lastSequence < current.lastSequence
				) {
					return { type: "ignore" };
				}
			}

			// After replace/reload the controller may be reset (position null) while a stale
			// getSnapshot is still in flight. New-generation events land in the buffer first;
			// applying the old snapshot would filter them out with sameBinding and wipe recovery.
			const bufferHasNewerBinding = entry.buffer.some(
				(envelope) => envelope.runtimeId !== snapshot.runtimeId || envelope.generation > snapshot.generation,
			);
			if (bufferHasNewerBinding) return { type: "ignore" };

			// Snapshot is authoritative. Replay only a contiguous prefix of the buffer after
			// the snapshot watermark; drop any gap/mismatch tail instead of failing closed into
			// a resync loop that re-reads the same poisoned buffer and clears the UI forever.
			let position = positionFromSnapshot(snapshot);
			const buffered = entry.buffer.filter(
				(envelope) => sameBinding(position, envelope) && envelope.sequence > position.lastSequence,
			);
			const eventsToApply: SessionEventEnvelope[] = [];
			for (const envelope of buffered) {
				if (envelope.sequence <= position.lastSequence) continue;
				if (envelope.sequence !== position.lastSequence + 1) break;
				const next = expectedPosition(position, envelope);
				if (!next) break;
				position = next;
				eventsToApply.push(envelope);
			}
			entry.position = position;
			entry.buffer = [];
			return { type: "apply", snapshot, bufferedEvents: eventsToApply };
		},
		getPosition(key) {
			return entries.get(key)?.position ?? null;
		},
		getEntryCount() {
			return entries.size;
		},
		reset(key) {
			entries.delete(key);
		},
	};
}

export const sessionStreamController = createSessionStreamController();
