import type {
	MetadataCleanupPendingSummary,
	MetadataCleanupRetryResult,
	MetadataCleanupStatus,
} from "@ling/contracts/diagnostics";
import { errorMessage } from "@ling/contracts/ling-error";
import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { requestCancelled } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { DatasetReadError } from "@ling/host/storage/dataset-envelope";
import { createHash } from "node:crypto";
import type {
	MetadataCleanupFact,
	MetadataCleanupOwnerId,
	MetadataCleanupRetryRecord,
	MetadataCleanupRetryStore,
} from "./metadata-cleanup-retry-store";

interface MetadataCleanupDependencies {
	retries: MetadataCleanupRetryStore;
	removeSessionFromCatalog(ref: SessionRef): Promise<void>;
	deleteChangeReviewSessionState(ref: SessionRef): Promise<void>;
	releaseChangeReviewProject(cwd: string): Promise<void>;
}

interface MetadataCleanupOwner {
	id: MetadataCleanupOwnerId;
	cleanup(fact: MetadataCleanupFact): Promise<void>;
}

interface MetadataCleanupOutcome {
	status: "complete" | "retryScheduled" | "retryRecordFailed";
	factId: string;
	failures: Partial<Record<MetadataCleanupOwnerId, string>>;
	retryError?: string;
}

interface MetadataCleanupCoordinator {
	cleanup(fact: MetadataCleanupFact): Promise<MetadataCleanupOutcome>;
	listPending(): Promise<MetadataCleanupRetryRecord[]>;
	retryPending(): Promise<MetadataCleanupOutcome[]>;
	shutdownRetries(): Promise<void>;
}

const log = createLogger("metadata-cleanup");

function factIdentity(fact: MetadataCleanupFact): string {
	const identity = fact.type === "sessionDeleted" ? sessionKey(fact.ref) : fact.project.cwd;
	const digest = createHash("sha256").update(identity).digest("hex");
	return `${fact.type}:${digest}`;
}

// Error messages in retry records are truncated to 4KiB
function truncatedErrorMessage(error: unknown): string {
	return errorMessage(error).slice(0, 4_096);
}

function defaultOwners({
	removeSessionFromCatalog,
	deleteChangeReviewSessionState,
	releaseChangeReviewProject,
}: MetadataCleanupDependencies): MetadataCleanupOwner[] {
	return [
		{
			id: "sessionCatalog",
			async cleanup(fact) {
				if (fact.type === "sessionDeleted") await removeSessionFromCatalog(fact.ref);
				// Removing a project is not deleting its Pi sessions. Catalog metadata is retained
				// so reopening the same canonical project can reattach it.
			},
		},
		{
			id: "changeReview",
			async cleanup(fact) {
				if (fact.type === "sessionDeleted") await deleteChangeReviewSessionState(fact.ref);
				else await releaseChangeReviewProject(fact.project.cwd);
			},
		},
	];
}

function createMetadataCleanupCoordinator(dependencies: MetadataCleanupDependencies): MetadataCleanupCoordinator {
	const owners = defaultOwners(dependencies);
	const { retries } = dependencies;
	const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
	let retryTail = Promise.resolve();
	let activeRetry: Promise<MetadataCleanupOutcome[]> | null = null;
	let retryShutdownPromise: Promise<void> | null = null;
	let retriesShuttingDown = false;

	async function run(
		fact: MetadataCleanupFact,
		ownerIds: readonly MetadataCleanupOwnerId[],
		factId = factIdentity(fact),
	): Promise<MetadataCleanupOutcome> {
		const failures: Partial<Record<MetadataCleanupOwnerId, string>> = {};
		// Drain review writes before catalog removal atomically deletes all session metadata.
		// Every owner is still attempted if another fails; only failed owners enter the retry journal.
		const ordered = [...ownerIds].sort((a, b) => Number(a === "sessionCatalog") - Number(b === "sessionCatalog"));
		for (const ownerId of ordered) {
			const owner = ownerById.get(ownerId);
			if (!owner) {
				failures[ownerId] = `Metadata cleanup owner is unavailable: ${ownerId}`;
				continue;
			}
			try {
				await owner.cleanup(fact);
			} catch (error) {
				failures[ownerId] = truncatedErrorMessage(error);
			}
		}
		if (Object.keys(failures).length > 0) {
			try {
				await retries.recordFailure(factId, fact, failures, Date.now());
				return { status: "retryScheduled", factId, failures };
			} catch (error) {
				return { status: "retryRecordFailed", factId, failures, retryError: truncatedErrorMessage(error) };
			}
		}
		try {
			await retries.remove(factId);
			return { status: "complete", factId, failures: {} };
		} catch (error) {
			return { status: "retryRecordFailed", factId, failures: {}, retryError: truncatedErrorMessage(error) };
		}
	}

	async function retryPending(): Promise<MetadataCleanupOutcome[]> {
		const records = await retries.list();
		const outcomes: MetadataCleanupOutcome[] = [];
		for (const record of records) outcomes.push(await run(record.fact, record.pendingOwnerIds, record.id));
		return outcomes;
	}

	function enqueueRetry(): Promise<MetadataCleanupOutcome[]> {
		if (retriesShuttingDown) {
			return Promise.reject(
				requestCancelled("The metadata cleanup retry was cancelled because Ling is shutting down."),
			);
		}
		if (activeRetry) return activeRetry;
		const operation = retryPending();
		const tracked: Promise<MetadataCleanupOutcome[]> = operation.finally(() => {
			if (activeRetry === tracked) activeRetry = null;
		});
		activeRetry = tracked;
		retryTail = tracked.then(
			() => undefined,
			() => undefined,
		);
		return tracked;
	}

	return {
		cleanup: (fact) =>
			run(
				fact,
				owners.map((owner) => owner.id),
			),
		async listPending() {
			await retryTail;
			return retries.list();
		},
		retryPending: enqueueRetry,
		shutdownRetries() {
			if (retryShutdownPromise) return retryShutdownPromise;
			retriesShuttingDown = true;
			retryShutdownPromise = retryTail;
			return retryShutdownPromise;
		},
	};
}

function projectPendingRecord(record: MetadataCleanupRetryRecord): MetadataCleanupPendingSummary {
	return {
		summaryId: createHash("sha256").update(record.id).digest("hex").slice(0, 16),
		factType: record.fact.type,
		pendingOwnerIds: [...record.pendingOwnerIds],
		attempts: record.attempts,
		firstFailedAt: record.firstFailedAt,
		lastAttemptAt: record.lastAttemptAt,
	};
}

function projectMetadataCleanupReadFailure(error: unknown): MetadataCleanupStatus | null {
	if (!(error instanceof DatasetReadError)) return null;
	return {
		protocolVersion: 1,
		status: "recoveryRequired",
		errorCode: error.code,
		foundVersion: error.foundVersion,
	};
}

function projectMetadataCleanupStatus(records: readonly MetadataCleanupRetryRecord[]): MetadataCleanupStatus {
	return {
		protocolVersion: 1,
		status: "ready",
		records: records.map(projectPendingRecord),
	};
}

export function metadataCleanupWarning(outcome: MetadataCleanupOutcome): string | null {
	if (outcome.status === "complete") return null;
	const ownerFailures = Object.entries(outcome.failures)
		.map(([owner, message]) => `${owner}: ${message}`)
		.join("; ");
	const retryFailure = outcome.retryError === undefined ? "" : `; retry journal: ${outcome.retryError}`;
	return `Metadata cleanup is incomplete and will be retried (${ownerFailures || "retry journal cleanup"}${retryFailure}).`;
}

export function sessionDeletedCleanupFact(ref: SessionRef, occurredAt = Date.now()): MetadataCleanupFact {
	return { type: "sessionDeleted", ref: { ...ref }, occurredAt };
}

export function createMetadataCleanupHost(dependencies: MetadataCleanupDependencies) {
	const coordinator = createMetadataCleanupCoordinator(dependencies);

	function coordinateMetadataCleanup(fact: MetadataCleanupFact): Promise<MetadataCleanupOutcome> {
		return coordinator.cleanup(fact);
	}

	async function getMetadataCleanupStatus(): Promise<MetadataCleanupStatus> {
		try {
			return projectMetadataCleanupStatus(await coordinator.listPending());
		} catch (error) {
			const recovery = projectMetadataCleanupReadFailure(error);
			if (recovery) return recovery;
			throw error;
		}
	}

	async function retryPendingMetadataCleanup(): Promise<MetadataCleanupRetryResult> {
		const outcomes = await coordinator.retryPending();
		for (const outcome of outcomes) {
			if (outcome.status !== "complete") log.error("metadata cleanup retry remains pending:", outcome);
		}
		const status = await getMetadataCleanupStatus();
		return {
			protocolVersion: 1,
			attemptedRecords: outcomes.length,
			completedRecords: outcomes.filter((outcome) => outcome.status === "complete").length,
			remainingRecords: status.status === "ready" ? status.records.length : outcomes.length,
			status,
		};
	}

	function shutdownMetadataCleanupRetries(): Promise<void> {
		return coordinator.shutdownRetries();
	}
	return { coordinateMetadataCleanup, retryPendingMetadataCleanup, shutdownMetadataCleanupRetries };
}

export type MetadataCleanupHost = ReturnType<typeof createMetadataCleanupHost>;
