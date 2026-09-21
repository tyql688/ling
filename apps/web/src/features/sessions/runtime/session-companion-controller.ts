import type { RuntimeCommandCatalogSnapshot, RuntimeExtensionUiSnapshot, SessionRef } from "@ling/contracts/session";
import { sameSessionRef } from "@ling/contracts/session-ref";

export interface SessionCompanionTarget {
	runtimeId: string;
	generation: number;
	commandCatalogRevision: number;
	extensionUiRevision: number;
}

type RuntimeCompanionSnapshot = RuntimeCommandCatalogSnapshot | RuntimeExtensionUiSnapshot;

export interface LatestCompanionRequestQueue<T> {
	schedule(target: T): void;
	dispose(): void;
}

/** Companion revisions can advance several times during one Pi reload. Keep at most one IPC
 * read in flight and retain only the newest target that arrived while it was running. */
export function createLatestCompanionRequestQueue<T>(
	read: (target: T) => Promise<void>,
	sameTarget: (left: T, right: T) => boolean,
	onError: (error: unknown) => void,
): LatestCompanionRequestQueue<T> {
	let activeTarget: T | null = null;
	let queuedTarget: T | null = null;
	let disposed = false;

	const start = (target: T): void => {
		activeTarget = target;
		void read(target)
			.catch(onError)
			.finally(() => {
				if (activeTarget !== target) return;
				activeTarget = null;
				if (disposed) {
					queuedTarget = null;
					return;
				}
				const next = queuedTarget;
				queuedTarget = null;
				if (next && !sameTarget(target, next)) start(next);
			});
	};

	return {
		schedule(target) {
			if (disposed) return;
			if (activeTarget) {
				if (!sameTarget(activeTarget, target)) queuedTarget = target;
				return;
			}
			start(target);
		},
		dispose() {
			disposed = true;
			queuedTarget = null;
		},
	};
}

function sameRuntimeTarget(left: SessionCompanionTarget | null, right: SessionCompanionTarget): boolean {
	return left !== null && left.runtimeId === right.runtimeId && left.generation === right.generation;
}

export function sameCommandCatalogTarget(left: SessionCompanionTarget | null, right: SessionCompanionTarget): boolean {
	return (
		left !== null && sameRuntimeTarget(left, right) && left.commandCatalogRevision === right.commandCatalogRevision
	);
}

export function sameExtensionUiTarget(left: SessionCompanionTarget | null, right: SessionCompanionTarget): boolean {
	return left !== null && sameRuntimeTarget(left, right) && left.extensionUiRevision === right.extensionUiRevision;
}

function companionSnapshotMatchesTarget(
	snapshot: RuntimeCompanionSnapshot,
	ref: SessionRef,
	target: SessionCompanionTarget,
	revision: number,
): boolean {
	return (
		snapshot.runtimeId === target.runtimeId &&
		snapshot.generation === target.generation &&
		snapshot.revision === revision &&
		sameSessionRef(snapshot.ref, ref)
	);
}

export function selectCompanionSnapshot<T extends RuntimeCompanionSnapshot>(
	current: T | null,
	next: T,
	ref: SessionRef,
	target: SessionCompanionTarget,
	revision: number,
): T | null {
	if (!companionSnapshotMatchesTarget(next, ref, target, revision)) return current;
	if (
		current &&
		current.runtimeId === next.runtimeId &&
		current.generation === next.generation &&
		current.revision > next.revision
	) {
		return current;
	}
	return next;
}
