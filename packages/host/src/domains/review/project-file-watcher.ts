import { notifyListeners } from "@ling/core/listeners";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "@ling/core/logger";
import { throwAggregateFailures } from "@ling/core/ling-error";

import { subscribe } from "../../runtime/filesystem-watcher";
import { pathIdentity } from "@ling/core/paths";
import { REVIEW_CAPTURE_EXCLUDED_DIRS } from "@ling/core/change-review/change-review";

const log = createLogger("project-file-watcher");
/** Same directory ignore set as the review capture, converted to @parcel/watcher globs to avoid node_modules-style noise. */
const WATCH_IGNORES = REVIEW_CAPTURE_EXCLUDED_DIRS.map((dir) => (dir.includes("/") ? `${dir}/**` : `**/${dir}/**`));
/**
 * Minimum quiet-period wait. 40ms filters the multi-event burst of a single save while barely delaying review refreshes.
 */
const SETTLE_MIN_DELAY_MS = 40;
/**
 * How long after the last event counts as "writes settled". 80ms covers continuous editor writes; longer feels sluggish.
 */
const SETTLE_QUIET_MS = 80;
/**
 * Maximum wait for a single settle. 750ms keeps a never-quiet watcher from hanging its caller.
 */
const SETTLE_MAX_WAIT_MS = 750;

type ProjectFileListener = () => void;

interface WatcherSlot {
	key: string;
	root: string;
	listeners: Set<ProjectFileListener>;
	refCount: number;
	lastEventAt: number;
	eventCount: number;
	failed: boolean;
	subscription: Awaited<ReturnType<typeof subscribe>> | null;
	stopSubscription: Promise<void> | null;
	ready: Promise<void>;
	closing: boolean;
}

function stopWatcherSubscription(slot: WatcherSlot): Promise<void> {
	if (slot.stopSubscription) return slot.stopSubscription;
	const subscription = slot.subscription;
	if (!subscription) return Promise.resolve();
	slot.subscription = null;
	const tracked: Promise<void> = subscription.unsubscribe().finally(() => {
		if (slot.stopSubscription === tracked) slot.stopSubscription = null;
	});
	slot.stopSubscription = tracked;
	return tracked;
}

export interface ProjectFileWatcherLease {
	readonly ready: Promise<void>;
	/** Monotonic change counter, or null while the watcher cannot observe events.
	 * A null clock must disable any cache keyed on it. */
	clock(): number | null;
	waitForIdle(): Promise<void>;
	dispose(): Promise<void>;
}

function createSlot(root: string, key: string): WatcherSlot {
	const slot: WatcherSlot = {
		key,
		root,
		listeners: new Set(),
		refCount: 0,
		lastEventAt: 0,
		eventCount: 0,
		failed: false,
		subscription: null,
		stopSubscription: null,
		ready: Promise.resolve(),
		closing: false,
	};
	slot.ready = subscribe(
		root,
		(error, events) => {
			if (slot.closing) return;
			if (error) {
				// Once a watcher errors it may silently drop events, so its clock
				// must stop vouching for "nothing changed".
				slot.failed = true;
				log.error(`project watcher failed for ${root}:`, error);
				void stopWatcherSubscription(slot).catch((unsubscribeError: unknown) => {
					log.error(`could not stop failed project watcher for ${root}:`, unsubscribeError);
				});
				return;
			}
			if (events.length === 0) return;
			slot.lastEventAt = Date.now();
			slot.eventCount += 1;
			notifyListeners(slot.listeners, `project watcher ${slot.root}`);
		},
		{ ignore: [...WATCH_IGNORES] },
	).then(async (subscription) => {
		slot.subscription = subscription;
		if (slot.closing || slot.failed) {
			await stopWatcherSubscription(slot);
			return;
		}
	});
	// A lease exposes the rejected readiness promise to its owner, but the shared
	// slot also observes it so a caller that only needs best-effort refresh cannot
	// create an unhandled rejection.
	void slot.ready.catch((error: unknown) => {
		slot.failed = true;
		log.error(`could not start project watcher for ${root}:`, error);
	});
	return slot;
}

async function waitForIdle(slot: WatcherSlot): Promise<void> {
	try {
		await slot.ready;
	} catch {
		return;
	}
	await delay(SETTLE_MIN_DELAY_MS);
	const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
	for (;;) {
		const quietFor = Date.now() - slot.lastEventAt;
		if (quietFor >= SETTLE_QUIET_MS || Date.now() >= deadline || slot.closing) return;
		await delay(Math.min(SETTLE_QUIET_MS - quietFor, 40));
	}
}

export function createProjectFileWatchers() {
	let disposal: Promise<void> | null = null;

	const slots = new Map<string, WatcherSlot>();

	async function releaseLease(slot: WatcherSlot, listener: ProjectFileListener): Promise<void> {
		slot.listeners.delete(listener);
		slot.refCount -= 1;
		if (slot.refCount < 0) throw new Error(`Project watcher reference count became negative for ${slot.root}`);
		if (slot.refCount > 0) return;
		slot.closing = true;
		if (slots.get(slot.key) === slot) slots.delete(slot.key);
		try {
			await slot.ready;
		} catch {
			return;
		}
		await stopWatcherSubscription(slot);
	}

	let shuttingDown = false;

	function acquireProjectFileWatcher(cwd: string, listener: ProjectFileListener): ProjectFileWatcherLease {
		if (shuttingDown) throw new Error("Project file watchers are shutting down");
		const root = resolve(cwd);
		const key = pathIdentity(root);
		const slot = slots.get(key) ?? createSlot(root, key);
		if (!slots.has(key)) slots.set(key, slot);
		if (slot.closing) throw new Error(`Project watcher is closing for ${root}`);
		slot.refCount += 1;
		slot.listeners.add(listener);
		let released = false;
		return {
			ready: slot.ready,
			clock: () => (slot.failed || slot.subscription === null ? null : slot.eventCount),
			waitForIdle: () => waitForIdle(slot),
			async dispose() {
				if (released) return;
				released = true;
				await releaseLease(slot, listener);
			},
		};
	}

	/**
	 * Stop every native subscription now, ahead of the slower owners in the shutdown sequence.
	 * A @parcel/watcher operation still in flight when the process exits aborts Node's
	 * environment teardown (napi fatal in its async cleanup hook), so the watchers go first and
	 * leases released later by closing sessions only observe an already-stopped slot: the
	 * reference counts keep decrementing normally and `stopWatcherSubscription` is idempotent.
	 */
	function shutdownProjectFileWatchers(): Promise<void> {
		if (disposal) return disposal;
		shuttingDown = true;
		const active = [...slots.values()];
		slots.clear();
		disposal = Promise.allSettled(
			active.map(async (slot) => {
				slot.closing = true;
				slot.listeners.clear();
				try {
					await slot.ready;
				} catch {
					return;
				}
				await stopWatcherSubscription(slot);
			}),
		).then((results) =>
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to stop project file watchers",
			),
		);
		return disposal;
	}
	return { acquire: acquireProjectFileWatcher, dispose: shutdownProjectFileWatchers };
}

export type ProjectFileWatchers = ReturnType<typeof createProjectFileWatchers>;
