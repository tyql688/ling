import type { ApprovalRequester, ExtensionUiRequester, ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import type {
	SessionRuntimeReplacementEvent,
	SessionRuntimeReplacementReservation,
} from "@ling/core/pi-protocol/runtime-types";

interface ReplacementOwner {
	lifecycleEpoch: number;
	extensionUiRequester?: ExtensionUiRequester;
	approvalRequester?: ApprovalRequester;
}

interface ReplacementReservationOptions<Owner extends ReplacementOwner> {
	extensionUi: ExtensionUiBridge;
	ownerFor: (ref: SessionRef) => Owner | undefined;
	targetLifecycleBusy: (ref: SessionRef) => boolean;
	commitOwner: (previousRef: SessionRef, nextRef: SessionRef, owner: Owner) => void;
}

interface ReservationRecord<Owner> {
	owner: Owner;
	generation: number;
	abort(): void;
}

export interface SessionReplacementReservations<Owner extends ReplacementOwner> {
	has(ref: SessionRef): boolean;
	prepare(owner: Owner, event: SessionRuntimeReplacementEvent): SessionRuntimeReplacementReservation;
	assertCommitted(owner: Owner, event: SessionRuntimeReplacementEvent): void;
	clear(owner: Owner): void;
}

function replacementTargetBusy(ref: SessionRef): Error & {
	code: "SESSION_REPLACEMENT_TARGET_BUSY";
	ref: SessionRef;
} {
	return Object.assign(new Error(`Session replacement target is busy: ${ref.sessionId}`), {
		code: "SESSION_REPLACEMENT_TARGET_BUSY" as const,
		ref,
	});
}

function staleReplacementReservation(event: SessionRuntimeReplacementEvent): Error & {
	code: "SESSION_REPLACEMENT_STALE";
	ref: SessionRef;
} {
	return Object.assign(new Error(`Session replacement ownership changed: ${event.previousRef.sessionId}`), {
		code: "SESSION_REPLACEMENT_STALE" as const,
		ref: event.previousRef,
	});
}

export function createSessionReplacementReservations<Owner extends ReplacementOwner>(
	options: ReplacementReservationOptions<Owner>,
): SessionReplacementReservations<Owner> {
	const reservations = new Map<string, ReservationRecord<Owner>>();

	function prepare(owner: Owner, event: SessionRuntimeReplacementEvent): SessionRuntimeReplacementReservation {
		const previousKey = sessionKey(event.previousRef);
		const nextKey = sessionKey(event.nextRef);
		const generation = owner.lifecycleEpoch;
		if (options.ownerFor(event.previousRef) !== owner) throw staleReplacementReservation(event);

		const targetOwner = options.ownerFor(event.nextRef);
		if (targetOwner && targetOwner !== owner) throw replacementTargetBusy(event.nextRef);
		if (options.targetLifecycleBusy(event.nextRef)) throw replacementTargetBusy(event.nextRef);
		const existingReservation = reservations.get(nextKey);
		if (existingReservation && existingReservation.owner !== owner) throw replacementTargetBusy(event.nextRef);

		let state: "pending" | "committed" | "aborted" = "pending";
		const requestersStaged = previousKey !== nextKey;
		if (requestersStaged) {
			if (owner.extensionUiRequester)
				options.extensionUi.registerExtensionUiRequester(event.nextRef, owner.extensionUiRequester);
			if (owner.approvalRequester)
				options.extensionUi.registerApprovalRequester(event.nextRef, owner.approvalRequester);
		}
		const record: ReservationRecord<Owner> = {
			owner,
			generation,
			abort() {
				if (state !== "pending") return;
				if (reservations.get(nextKey) === record) reservations.delete(nextKey);
				if (requestersStaged) {
					if (owner.extensionUiRequester) {
						options.extensionUi.unregisterExtensionUiRequester(event.nextRef, owner.extensionUiRequester);
					}
					if (owner.approvalRequester)
						options.extensionUi.unregisterApprovalRequester(event.nextRef, owner.approvalRequester);
				}
				state = "aborted";
			},
		};
		reservations.set(nextKey, record);
		return {
			commit() {
				if (state === "committed") return;
				if (
					state === "aborted" ||
					reservations.get(nextKey) !== record ||
					owner.lifecycleEpoch !== generation ||
					options.ownerFor(event.previousRef) !== owner
				) {
					throw staleReplacementReservation(event);
				}
				const currentTargetOwner = options.ownerFor(event.nextRef);
				if (currentTargetOwner && currentTargetOwner !== owner) throw replacementTargetBusy(event.nextRef);

				reservations.delete(nextKey);
				options.commitOwner(event.previousRef, event.nextRef, owner);
				owner.lifecycleEpoch += 1;
				state = "committed";
			},
			abort: record.abort,
		};
	}

	return {
		has(ref) {
			return reservations.has(sessionKey(ref));
		},
		prepare,
		assertCommitted(owner, event) {
			if (options.ownerFor(event.nextRef) !== owner) throw staleReplacementReservation(event);
		},
		clear(owner) {
			for (const reservation of [...reservations.values()]) {
				if (reservation.owner === owner) reservation.abort();
			}
		},
	};
}
