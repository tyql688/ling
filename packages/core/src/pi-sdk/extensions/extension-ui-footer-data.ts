import {
	EXTENSION_UI_KEY_MAX_CHARS,
	EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS,
	EXTENSION_UI_TEXT_MAX_CHARS,
} from "@ling/contracts/session-extension-ui";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { throwAggregateFailures } from "@ling/core/ling-error";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../logger";
import { unsupportedExtensionUi as unsupported } from "../../pi-protocol/extension-ui";
import type { PiReadonlyFooterDataProvider } from "../types";

interface FooterDataProviderOptions {
	getAvailableProviderCount?: () => number;
	onBranchChanged: () => void;
	assertActive: () => void;
}

interface BranchConsumer {
	callbacks: Set<() => void>;
	onBranchChanged: () => void;
	leases: number;
}

interface BranchWatcher {
	cwd: string;
	lastBranch: string | null;
	hasRead: boolean;
	consumers: Map<string, BranchConsumer>;
	timer: ReturnType<typeof setInterval> | null;
	poll: Promise<void> | null;
	pollController: AbortController | null;
}

const log = createLogger("pi-extension-ui-footer");
/** Git branch poll interval; 5s is timely enough for the status bar, anything tighter would hit disk/spawn subprocesses too often. */
const BRANCH_POLL_INTERVAL_MS = 5000;
/** Timeout for a single git branch read; 4s < the poll interval, avoiding overlapping exec pileups. */
const BRANCH_READ_TIMEOUT_MS = 4000;
/** Git branch command stdout limit; 64Ki far exceeds any branch name, guarding against abnormal output filling the buffer. */
const BRANCH_READ_MAX_BUFFER_BYTES = 64 * 1024;
/** A buggy footer must not retain unbounded callback/unsubscribe closure pairs. */
const EXTENSION_BRANCH_SUBSCRIPTION_MAX_ITEMS = 64;

const execFileAsync = promisify(execFile);

async function readGitBranch(cwd: string, signal: AbortSignal): Promise<string | null> {
	try {
		// The try/catch still covers a synchronous spawn throw, exactly as the callback form did.
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
			maxBuffer: BRANCH_READ_MAX_BUFFER_BYTES,
			signal,
			timeout: BRANCH_READ_TIMEOUT_MS,
			windowsHide: true,
		});
		const branch = stdout.trim();
		return branch.length === 0 ? null : branch === "HEAD" ? "detached" : branch;
	} catch {
		return null;
	}
}

function notifyBranchChanged(watcher: BranchWatcher): void {
	for (const consumer of watcher.consumers.values()) {
		for (const callback of consumer.callbacks) {
			try {
				callback();
			} catch (error) {
				log.error(`branch listener failed for ${watcher.cwd}:`, error);
			}
		}
		try {
			consumer.onBranchChanged();
		} catch (error) {
			log.error(`footer rerender failed for ${watcher.cwd}:`, error);
		}
	}
}

function stopBranchPolling(watcher: BranchWatcher): void {
	if (!watcher.timer) return;
	clearInterval(watcher.timer);
	watcher.timer = null;
}

function hasBranchSubscribers(watcher: BranchWatcher): boolean {
	for (const consumer of watcher.consumers.values()) {
		if (consumer.callbacks.size > 0) return true;
	}
	return false;
}

export interface FooterDataProviderLease {
	provider: PiReadonlyFooterDataProvider;
	dispose(): void;
}

export function createPiExtensionFooterData() {
	const pendingPolls = new Set<Promise<void>>();

	const extensionStatusTextBySession = new Map<string, Map<string, string>>();
	const branchWatchersByCwd = new Map<string, BranchWatcher>();

	function extensionStatusMap(ref: SessionRef): Map<string, string> {
		const key = sessionKey(ref);
		const existing = extensionStatusTextBySession.get(key);
		if (existing) return existing;
		const created = new Map<string, string>();
		extensionStatusTextBySession.set(key, created);
		return created;
	}

	function setPiExtensionStatus(ref: SessionRef, key: string, text: string | undefined): void {
		if (key.length > EXTENSION_UI_KEY_MAX_CHARS) unsupported("setStatus.key");
		const session = sessionKey(ref);
		if (text === undefined) {
			const statuses = extensionStatusTextBySession.get(session);
			if (!statuses) return;
			statuses.delete(key);
			if (statuses.size === 0) extensionStatusTextBySession.delete(session);
			return;
		}
		if (text.length > EXTENSION_UI_TEXT_MAX_CHARS) unsupported("setStatus.text");
		const statuses = extensionStatusMap(ref);
		if (!statuses.has(key) && statuses.size >= EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS) unsupported("setStatus.count");
		statuses.set(key, text);
	}

	function pollBranch(watcher: BranchWatcher): Promise<void> {
		if (watcher.poll) return watcher.poll;
		const controller = new AbortController();
		watcher.pollController = controller;
		const operation = readGitBranch(watcher.cwd, controller.signal).then((branch) => {
			if (controller.signal.aborted || branchWatchersByCwd.get(watcher.cwd) !== watcher) return;
			const changed = watcher.hasRead ? watcher.lastBranch !== branch : branch !== null;
			watcher.hasRead = true;
			watcher.lastBranch = branch;
			if (changed) notifyBranchChanged(watcher);
		});
		const tracked = operation.finally(() => {
			pendingPolls.delete(tracked);
			if (watcher.poll === tracked) watcher.poll = null;
			if (watcher.pollController === controller) watcher.pollController = null;
		});
		pendingPolls.add(tracked);
		watcher.poll = tracked;
		return tracked;
	}

	function ensureBranchWatcher(ref: SessionRef, onBranchChanged: () => void): BranchWatcher {
		let watcher = branchWatchersByCwd.get(ref.cwd);
		if (!watcher) {
			watcher = {
				cwd: ref.cwd,
				lastBranch: null,
				hasRead: false,
				consumers: new Map(),
				timer: null,
				poll: null,
				pollController: null,
			};
			branchWatchersByCwd.set(ref.cwd, watcher);
		}
		const key = sessionKey(ref);
		const consumer = watcher.consumers.get(key);
		if (consumer) consumer.onBranchChanged = onBranchChanged;
		else watcher.consumers.set(key, { callbacks: new Set(), onBranchChanged, leases: 0 });
		void pollBranch(watcher);
		return watcher;
	}

	function startBranchPolling(watcher: BranchWatcher): void {
		if (watcher.timer) return;
		watcher.timer = setInterval(() => {
			void pollBranch(watcher);
		}, BRANCH_POLL_INTERVAL_MS);
		watcher.timer.unref();
	}

	function watchBranch(
		ref: SessionRef,
		watcher: BranchWatcher,
		consumer: BranchConsumer,
		callback: () => void,
	): () => void {
		const key = sessionKey(ref);
		if (branchWatchersByCwd.get(ref.cwd) !== watcher || watcher.consumers.get(key) !== consumer) {
			throw new Error(`Footer branch consumer is no longer active: ${key}`);
		}
		consumer.callbacks.add(callback);
		startBranchPolling(watcher);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			// Cleanup handles can outlive their extension generation. Remove only from
			// the consumer captured at registration, never a replacement under the same
			// SessionRef (which may intentionally reuse the same callback identity).
			consumer.callbacks.delete(callback);
			const activeWatcher = branchWatchersByCwd.get(ref.cwd);
			if (activeWatcher !== watcher) return;
			if (!hasBranchSubscribers(activeWatcher)) stopBranchPolling(activeWatcher);
		};
	}

	function createFooterDataProviderLease(ref: SessionRef, options: FooterDataProviderOptions): FooterDataProviderLease {
		const watcher = ensureBranchWatcher(ref, options.onBranchChanged);
		const key = sessionKey(ref);
		const consumer = watcher.consumers.get(key);
		if (!consumer) throw new Error(`Missing footer branch consumer: ${key}`);
		consumer.leases += 1;
		const subscriptions = new Set<() => void>();
		let disposed = false;
		const assertLeaseActive = () => {
			options.assertActive();
			if (disposed) throw new Error(`Footer data provider is no longer active: ${key}`);
		};
		const provider: PiReadonlyFooterDataProvider = {
			getGitBranch: () => {
				assertLeaseActive();
				return watcher.lastBranch;
			},
			getExtensionStatuses: () => {
				assertLeaseActive();
				return new Map(extensionStatusTextBySession.get(key));
			},
			getAvailableProviderCount: () => {
				assertLeaseActive();
				if (!options.getAvailableProviderCount) unsupported("setFooter.footerData.getAvailableProviderCount");
				return options.getAvailableProviderCount();
			},
			onBranchChange: (callback) => {
				assertLeaseActive();
				if (subscriptions.size >= EXTENSION_BRANCH_SUBSCRIPTION_MAX_ITEMS) {
					unsupported("footerData.onBranchChange.count");
				}
				const unsubscribeBranch = watchBranch(ref, watcher, consumer, callback);
				let subscribed = true;
				const unsubscribe = () => {
					if (!subscribed) return;
					subscribed = false;
					subscriptions.delete(unsubscribe);
					unsubscribeBranch();
				};
				subscriptions.add(unsubscribe);
				return unsubscribe;
			},
		};
		return {
			provider,
			dispose() {
				if (disposed) return;
				disposed = true;
				for (const unsubscribe of [...subscriptions]) unsubscribe();
				const active = branchWatchersByCwd.get(ref.cwd);
				if (active !== watcher || active.consumers.get(key) !== consumer) return;
				consumer.leases -= 1;
				if (consumer.leases < 0) throw new Error(`Footer branch consumer lease count became negative: ${key}`);
				if (consumer.leases > 0) return;
				active.consumers.delete(key);
				if (active.consumers.size > 0) {
					if (!hasBranchSubscribers(active)) stopBranchPolling(active);
					return;
				}
				stopBranchPolling(active);
				active.pollController?.abort();
				branchWatchersByCwd.delete(ref.cwd);
			},
		};
	}

	function disposePiExtensionFooterData(ref: SessionRef): void {
		const key = sessionKey(ref);
		extensionStatusTextBySession.delete(key);
		const watcher = branchWatchersByCwd.get(ref.cwd);
		if (!watcher) return;
		watcher.consumers.delete(key);
		if (watcher.consumers.size > 0) {
			if (!hasBranchSubscribers(watcher)) stopBranchPolling(watcher);
			return;
		}
		stopBranchPolling(watcher);
		watcher.pollController?.abort();
		branchWatchersByCwd.delete(ref.cwd);
	}

	function dispose(): Promise<void> {
		for (const watcher of branchWatchersByCwd.values()) {
			stopBranchPolling(watcher);
			watcher.pollController?.abort();
		}
		branchWatchersByCwd.clear();
		extensionStatusTextBySession.clear();
		return Promise.allSettled([...pendingPolls]).then((results) => {
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to stop extension footer polling",
			);
		});
	}
	return { setPiExtensionStatus, createFooterDataProviderLease, disposePiExtensionFooterData, dispose };
}

export type PiExtensionFooterData = ReturnType<typeof createPiExtensionFooterData>;
