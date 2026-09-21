import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import { createLogger } from "@ling/core/logger";
import type { ManagedSession } from "./session-managed-state";

const log = createLogger("session-auto-title");

interface SessionAutoTitleOptions {
	publishTitle(ref: SessionRef, title: string): void;
	isCurrent(managed: ManagedSession): boolean;
	track(cwd: string, operation: Promise<void>): Promise<void>;
	publishSummary(managed: ManagedSession): void;
}

function stillOwnsTitleRevision(
	managed: ManagedSession,
	refKey: string,
	lifecycleEpoch: number,
	titleRevision: number,
	options: SessionAutoTitleOptions,
): boolean {
	return (
		!managed.disposing &&
		managed.lifecycleEpoch === lifecycleEpoch &&
		managed.titleRevision === titleRevision &&
		sessionKey(managed.ref) === refKey &&
		options.isCurrent(managed)
	);
}

async function maybeAutoTitle(managed: ManagedSession, options: SessionAutoTitleOptions): Promise<void> {
	if (!managed.autoTitleEnabled || managed.autoTitleInFlight) return;
	managed.autoTitleInFlight = true;
	const refKey = sessionKey(managed.ref);
	const lifecycleEpoch = managed.lifecycleEpoch;
	const titleRevision = managed.titleRevision;
	const sessionId = managed.ref.sessionId;

	try {
		const firstUserMessage = await managed.session.getFirstUserMessageText();
		if (!firstUserMessage) {
			if (stillOwnsTitleRevision(managed, refKey, lifecycleEpoch, titleRevision, options)) {
				managed.autoTitleInFlight = false;
			}
			return;
		}
		const title = await managed.session.generateTitle(firstUserMessage);
		if (!stillOwnsTitleRevision(managed, refKey, lifecycleEpoch, titleRevision, options)) return;
		if (!title) {
			managed.autoTitleInFlight = false;
			return;
		}
		await managed.session.setSessionName(title);
		if (!stillOwnsTitleRevision(managed, refKey, lifecycleEpoch, titleRevision, options)) return;
		// setSessionName appends to the session JSONL; accept Ling's own write.
		void managed.fileSync.acceptCurrentState();
		managed.placeholderTitle = title;
		managed.autoTitleEnabled = false;
		managed.autoTitleInFlight = false;
		managed.titleRevision += 1;
		options.publishTitle(managed.ref, title);
		options.publishSummary(managed);
	} catch (error) {
		if (stillOwnsTitleRevision(managed, refKey, lifecycleEpoch, titleRevision, options)) {
			log.error(`auto-title failed for ${sessionId} (will retry after next turn):`, error);
			managed.autoTitleInFlight = false;
		}
	}
}

export function startSessionAutoTitle(managed: ManagedSession, options: SessionAutoTitleOptions): void {
	void options.track(managed.cwd, maybeAutoTitle(managed, options)).catch((error: unknown) => {
		log.error(`auto-title lifecycle failed for ${managed.ref.sessionId}:`, error);
	});
}

export function disableSessionAutoTitle(managed: ManagedSession): void {
	managed.autoTitleEnabled = false;
	managed.autoTitleInFlight = false;
}
