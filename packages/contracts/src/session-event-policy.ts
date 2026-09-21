import type { LingSessionEvent, SessionEventDeliveryClass } from "./session";

interface SessionEventPolicy {
	deliveryClass: SessionEventDeliveryClass;
	stateEffect: boolean;
	transcriptEffect: boolean;
}

/** Canonical V1 event policy. Producers and consumers use the same registry so callers cannot
 * downgrade delivery or invent revision effects per frame. */
export function sessionEventPolicy(event: LingSessionEvent): SessionEventPolicy {
	switch (event.type) {
		case "messageStart":
		case "messageUpdate":
		case "messageDelta":
		case "messageEnd":
		case "turnEnd":
		case "compactionSummary":
		case "transcriptInvalidated":
		case "transcriptProjectionChanged":
			return { deliveryClass: "snapshotRecoverable", stateEffect: false, transcriptEffect: true };
		case "messagePersisted":
			return { deliveryClass: "durableFact", stateEffect: false, transcriptEffect: true };
		case "toolExecutionChanged":
		case "queueChanged":
		case "commandsChanged":
		case "extensionUiChanged":
		case "runStarted":
		case "summarizationRetryChanged":
		case "autoRetryChanged":
			return { deliveryClass: "snapshotRecoverable", stateEffect: true, transcriptEffect: false };
		case "snapshotChanged":
			return { deliveryClass: "snapshotRecoverable", stateEffect: true, transcriptEffect: true };
		case "sessionReplaced":
		case "sessionSummaryChanged":
		case "sessionCatalogChanged":
		case "runFinished":
			return { deliveryClass: "durableFact", stateEffect: true, transcriptEffect: false };
		case "activity":
			return { deliveryClass: "telemetry", stateEffect: false, transcriptEffect: false };
	}
}
