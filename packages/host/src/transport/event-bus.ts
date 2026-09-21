interface HostEventEnvelope {
	sequence: number;
	channel: string;
	payload: unknown;
	targetClientId: string | null;
}

export interface HostEventPublisher {
	broadcast(channel: string, payload: unknown): void;
	send(clientId: string, channel: string, payload: unknown): void;
}

export interface HostEventBus extends HostEventPublisher {
	currentSequence(): number;
	replaySince(
		sequence: number,
		clientId: string,
	):
		| { status: "available"; events: HostEventEnvelope[]; currentSequence: number }
		| { status: "unavailable"; currentSequence: number };
	subscribe(listener: (event: HostEventEnvelope) => void): () => void;
}

export function createHostEventBus(): HostEventBus {
	const listeners = new Set<(event: HostEventEnvelope) => void>();
	const history: { event: HostEventEnvelope; bytes: number }[] = [];
	const targetReplayFloors = new Map<string, number>();
	let broadcastReplayFloor = 0;
	let sequence = 0;
	let historyBytes = 0;
	/** Retained event count bounds reconnect memory while covering ordinary short network interruptions. */
	const HISTORY_CAPACITY = 2_048;
	/** Two maximum protocol frames of serialized UTF-16 content; large updates shorten replay, not live delivery. */
	const HISTORY_BYTE_CAPACITY = 32 * 1_024 * 1_024;
	/** Bound disconnected-client tombstones as well as payloads; older floors become a conservative global floor. */
	const TARGET_REPLAY_FLOOR_CAPACITY = 2_048;
	/** JavaScript strings may require two bytes per UTF-16 code unit. */
	const STRING_CODE_UNIT_BYTES = 2;
	const publish = (channel: string, payload: unknown, targetClientId: string | null): void => {
		const event = { sequence: sequence + 1, channel, payload, targetClientId };
		// Measure wire content without retaining a second serialized copy of shared DTOs.
		const bytes = JSON.stringify(event).length * STRING_CODE_UNIT_BYTES;
		sequence += 1;
		history.push({ event, bytes });
		historyBytes += bytes;
		while (history.length > HISTORY_CAPACITY || historyBytes > HISTORY_BYTE_CAPACITY) {
			const discarded = history.shift();
			if (!discarded) break;
			historyBytes -= discarded.bytes;
			const { event: discardedEvent } = discarded;
			if (discardedEvent.targetClientId === null) {
				broadcastReplayFloor = Math.max(broadcastReplayFloor, discardedEvent.sequence);
			} else {
				targetReplayFloors.delete(discardedEvent.targetClientId);
				targetReplayFloors.set(discardedEvent.targetClientId, discardedEvent.sequence);
				if (targetReplayFloors.size > TARGET_REPLAY_FLOOR_CAPACITY) {
					const oldest = targetReplayFloors.entries().next().value;
					if (oldest) {
						broadcastReplayFloor = Math.max(broadcastReplayFloor, oldest[1]);
						targetReplayFloors.delete(oldest[0]);
					}
				}
			}
		}
		for (const listener of listeners) listener(event);
	};
	return {
		currentSequence: () => sequence,
		broadcast: (channel, payload) => publish(channel, payload, null),
		send: (clientId, channel, payload) => publish(channel, payload, clientId),
		replaySince: (lastSequence, clientId) => {
			const replayFloor = Math.max(broadcastReplayFloor, targetReplayFloors.get(clientId) ?? 0);
			if (lastSequence < replayFloor) return { status: "unavailable", currentSequence: sequence };
			return {
				status: "available",
				currentSequence: sequence,
				events: history
					.filter(
						({ event }) =>
							event.sequence > lastSequence && (event.targetClientId === null || event.targetClientId === clientId),
					)
					.map(({ event }) => event),
			};
		},
		subscribe: (listener) => {
			listeners.add(listener);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				listeners.delete(listener);
			};
		},
	};
}
