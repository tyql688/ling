import { reduceSessionView } from "./session-view";
import { sessionViewFamily } from "../state/session";
import { uniqueSessionRefs, sessionKey } from "@ling/contracts/session-ref";
import type { SessionRef } from "@ling/contracts/session";
import { sessionStreamController } from "@renderer/features/sessions/runtime/session-stream-controller";
import { forgetSessionScrollMemory } from "@renderer/features/sessions/runtime/transcript-scroll-memory";
import { draftsAtom } from "@renderer/features/sessions/state/drafts";
import { sessionSeenAtAtom, sessionSeenAtFamily } from "@renderer/features/sessions/state/seen";
import {
	activeSessionRefAtom,
	pendingApprovalQueueAtom,
	pendingExtensionUiQueueAtom,
	sessionMessagesFamily,
	sessionTranscriptStateFamily,
} from "@renderer/features/sessions/state/session";
import { attachmentDataUrlBytes } from "@renderer/features/sessions/state/image-attachment-policy";
import type { createStore } from "jotai/vanilla";

type Store = ReturnType<typeof createStore>;
type RendererSessionStateToken = symbol;
type RendererSessionEvictionListener = (keys: readonly string[]) => void;

const sessionStateTokens = new Map<string, RendererSessionStateToken>();
/** Only live/resuming runtimes have a revision entry; final suspension removes it. */
const sessionRetentionRevisions = new Map<string, number>();
const evictionListeners = new Set<RendererSessionEvictionListener>();
/** Keep four recently suspended transcripts warm for fast history display after their workers exit. */
const DORMANT_TRANSCRIPT_CAPACITY = 4;
/** Limit serialized UTF-16 content to 16 MiB so a few large transcripts cannot defeat the entry limit. */
const DORMANT_TRANSCRIPT_BYTE_CAPACITY = 16 * 1_024 * 1_024;
/** JavaScript strings may require two bytes per UTF-16 code unit. */
const STRING_CODE_UNIT_BYTES = 2;
const dormantTranscriptsByStore = new WeakMap<Store, Map<string, number>>();

interface RendererSessionResourceSnapshot {
	sessionViewRecords: number;
	atomFamilyEntries: { seenAt: number };
	sessionAtomKeys: number;
	streamControllerEntries: number;
	draftEntries: number;
	draftAttachmentCount: number;
	draftAttachmentDataUrlBytes: number;
	seenEntries: number;
	stateTokens: number;
	retentionRevisions: number;
	evictionListeners: number;
	dormantTranscripts: number;
	dormantTranscriptBytes: number;
}

function nonEmptyFamilyParams(family: { getParams(): Iterable<string> }): string[] {
	return [...family.getParams()].filter((key) => key.length > 0);
}

function removeRecordKeys<T>(current: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
	let next: Record<string, T> | null = null;
	for (const key of keys) {
		if (!(key in current)) continue;
		if (!next) next = { ...current };
		delete next[key];
	}
	return next ?? current;
}

function resetSessionRuntimeAtoms(
	store: Store,
	key: string,
	removeSeenAt: boolean,
	preserveCompleteTranscript: boolean,
): void {
	dormantTranscriptsByStore.get(store)?.delete(key);
	const transcriptAtom = sessionTranscriptStateFamily(key);
	const transcript = store.get(transcriptAtom);
	const retainTranscript =
		preserveCompleteTranscript &&
		transcript.hydrationSettled &&
		!transcript.hasOlder &&
		transcript.transcriptCacheKey !== null;
	store.set(sessionViewFamily(key), (current) =>
		reduceSessionView(current, { type: "hibernate", preserveTranscript: retainTranscript }),
	);
	if (retainTranscript) retainDormantTranscript(store, key);
	else sessionViewFamily.remove(key);

	if (removeSeenAt) {
		// jotai-family retains params forever unless remove() is called; without this,
		// every deleted session leaves a derived seen-at atom behind.
		sessionSeenAtFamily.remove(key);
	}
}

function dropDormantTranscript(store: Store, key: string): void {
	store.set(sessionViewFamily(key), (current) => reduceSessionView(current, { type: "evict" }));
	sessionViewFamily.remove(key);
}

function retainDormantTranscript(store: Store, key: string): void {
	let bytes = 0;
	for (const message of store.get(sessionMessagesFamily(key))) {
		bytes += JSON.stringify(message).length * STRING_CODE_UNIT_BYTES;
		if (bytes > DORMANT_TRANSCRIPT_BYTE_CAPACITY) {
			dropDormantTranscript(store, key);
			return;
		}
	}
	let dormant = dormantTranscriptsByStore.get(store);
	if (!dormant) {
		dormant = new Map();
		dormantTranscriptsByStore.set(store, dormant);
	}
	dormant.set(key, bytes);
	let totalBytes = [...dormant.values()].reduce((total, size) => total + size, 0);
	for (const [oldestKey, oldestBytes] of dormant) {
		if (dormant.size <= DORMANT_TRANSCRIPT_CAPACITY && totalBytes <= DORMANT_TRANSCRIPT_BYTE_CAPACITY) break;
		dormant.delete(oldestKey);
		totalBytes -= oldestBytes;
		// A remote resume can acquire a hydration token before the local wake path runs.
		// Its in-flight snapshot may reuse this cache, so active owners must keep it intact.
		if (sessionStateTokens.has(oldestKey) || sessionRetentionRevisions.has(oldestKey)) continue;
		// Only the in-memory transcript expires. Identity-owned drafts and scroll state survive.
		dropDormantTranscript(store, oldestKey);
	}
}

export function captureRendererSessionState(key: string): RendererSessionStateToken {
	const current = sessionStateTokens.get(key);
	if (current) return current;
	const created = Symbol(key);
	sessionStateTokens.set(key, created);
	return created;
}

export function isRendererSessionStateCurrent(key: string, token: RendererSessionStateToken): boolean {
	return sessionStateTokens.get(key) === token;
}

export function setRendererSessionError(store: Store, key: string, message: string | null): void {
	store.set(sessionViewFamily(key), (current) => ({
		...current,
		errorMessage: message,
		error: message !== null && message.length > 0,
	}));
}

export function onRendererSessionStateEvicted(listener: RendererSessionEvictionListener): () => void {
	evictionListeners.add(listener);
	return () => evictionListeners.delete(listener);
}

function releaseRendererSessionRuntimeState(
	store: Store,
	keys: readonly string[],
	removeSeenAt: boolean,
	preserveCompleteTranscript = false,
): void {
	for (const key of keys) {
		sessionStateTokens.delete(key);
		sessionStreamController.reset(key);
	}
	for (const listener of evictionListeners) listener(keys);
	for (const key of keys) resetSessionRuntimeAtoms(store, key, removeSeenAt, preserveCompleteTranscript);
}

/** Drops live runtime state while retaining a bounded cache of complete transcripts for fast reopen.
 * Drafts, seen markers, dock preference, selection, and scroll position intentionally survive. */
export function hibernateRendererSessionState(store: Store, ref: SessionRef, retentionRevision: number): void {
	const key = sessionKey(ref);
	const currentRevision = sessionRetentionRevisions.get(key);
	if (currentRevision !== undefined && retentionRevision < currentRevision) return;
	releaseRendererSessionRuntimeState(store, [key], false, true);
	// RuntimeSuspended is the final ordered host event after core disposal. There is
	// no longer a retired binding to tombstone, and suspended catalog history costs 0 slots.
	sessionRetentionRevisions.delete(key);
}

/** A Pi command replacement moves the one live runtime to `nextRef`; the durable
 * previous session remains in the catalog but must not keep its transcript projection. */
export function retireReplacedRendererSessionState(store: Store, previousRef: SessionRef, nextRef: SessionRef): void {
	const previousKey = sessionKey(previousRef);
	if (previousKey === sessionKey(nextRef)) return;
	sessionRetentionRevisions.delete(previousKey);
	releaseRendererSessionRuntimeState(store, [previousKey], false);
}

/** Opens the renderer hydration gate only after main has successfully restored the runtime. */
export function wakeRendererSessionState(store: Store, ref: SessionRef, retentionRevision: number): void {
	const key = sessionKey(ref);
	const currentRevision = sessionRetentionRevisions.get(key);
	if (currentRevision !== undefined && retentionRevision < currentRevision) return;
	dormantTranscriptsByStore.get(store)?.delete(key);
	sessionRetentionRevisions.set(key, retentionRevision);
	// The explicit snapshot refresh that follows resume is the authoritative new binding.
	sessionStreamController.reset(key);
	store.set(sessionViewFamily(key), (current) => reduceSessionView(current, { type: "wake" }));
}

export function evictRendererSessionState(store: Store, refs: readonly SessionRef[]): void {
	const uniqueRefs = uniqueSessionRefs(refs);
	if (uniqueRefs.length === 0) return;
	const keys = uniqueRefs.map(sessionKey);
	const keySet = new Set(keys);
	for (const key of keys) sessionRetentionRevisions.delete(key);

	// Drop scroll memory together with the atoms so deleted sessions don't occupy Map slots.
	forgetSessionScrollMemory(keys);

	store.set(draftsAtom, (current) => removeRecordKeys(current, keySet));
	store.set(sessionSeenAtAtom, (current) => removeRecordKeys(current, keySet));
	store.set(pendingApprovalQueueAtom, (current) => current.filter((request) => !keySet.has(sessionKey(request.ref))));
	store.set(pendingExtensionUiQueueAtom, (current) =>
		current.filter((request) => !keySet.has(sessionKey(request.ref))),
	);
	store.set(activeSessionRefAtom, (current) => (current && keySet.has(sessionKey(current)) ? null : current));

	releaseRendererSessionRuntimeState(store, keys, true);
}

export function getRendererSessionResourceSnapshot(store: Store): RendererSessionResourceSnapshot {
	const familyEntries = {
		seenAt: nonEmptyFamilyParams(sessionSeenAtFamily).length,
	};
	const viewKeys = nonEmptyFamilyParams(sessionViewFamily);
	const sessionKeys = new Set([...viewKeys, ...nonEmptyFamilyParams(sessionSeenAtFamily)]);
	const drafts = Object.values(store.get(draftsAtom));
	const draftAttachments = drafts.flatMap((draft) => draft.attachments);
	return {
		atomFamilyEntries: familyEntries,
		sessionViewRecords: viewKeys.length,
		sessionAtomKeys: sessionKeys.size,
		streamControllerEntries: sessionStreamController.getEntryCount(),
		draftEntries: drafts.length,
		draftAttachmentCount: draftAttachments.length,
		draftAttachmentDataUrlBytes: attachmentDataUrlBytes(draftAttachments),
		seenEntries: Object.keys(store.get(sessionSeenAtAtom)).length,
		stateTokens: sessionStateTokens.size,
		retentionRevisions: sessionRetentionRevisions.size,
		evictionListeners: evictionListeners.size,
		dormantTranscripts: dormantTranscriptsByStore.get(store)?.size ?? 0,
		dormantTranscriptBytes: [...(dormantTranscriptsByStore.get(store)?.values() ?? [])].reduce(
			(total, bytes) => total + bytes,
			0,
		),
	};
}
