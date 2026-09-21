import type {
	ReadTranscriptPageRequest,
	SessionMessage,
	SessionRef,
	TranscriptPage,
	TranscriptPageDirection,
} from "@ling/contracts/session";
import { sameSessionRef, sessionKey } from "@ling/contracts/session-ref";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Paging protocol/cursor version; bumping invalidates old cursors (deliberately, to prevent cross-generation reads). */
const PROTOCOL_VERSION = 1 as const;
/**
 * Default page size. Opening a session hydrates the full timeline (with deferred tool bodies), so paging is IPC slicing rather than
 * UX segmentation: take the schema maximum of 200 to reduce round trips; each page is still truncated by
 * DEFAULT_PAGE_MAX_BYTES.
 */
const DEFAULT_PAGE_LIMIT = 200;
/**
 * Serialized byte limit per page. 8MiB stays manageable alongside large messages/image metadata; oversized pages are
 * truncated so one read cannot crush the renderer process.
 */
const DEFAULT_PAGE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * TTL of a pinned paging view. Opening a session hydrates many pages; 2min was too tight — cursors expired easily
 * on long sessions, cold disks, or mid-hydration snapshotChanged→invalidate→re-pin cycles. 30min covers hydration
 * plus browsing, with maxViews still reclaiming views.
 */
const DEFAULT_PIN_TTL_MS = 30 * 60 * 1000;
/**
 * Max simultaneously pinned views. 8 ≈ a small window each for multiple tabs/sessions; more would hold memory unboundedly.
 */
const DEFAULT_MAX_VIEWS = 8;
/**
 * Max message identities a single pager can index. 250k covers very long sessions; higher only increases HMAC/Map cost.
 */
const DEFAULT_MAX_IDENTITIES = 250_000;
/**
 * Total byte limit of the identity index (32MiB). A second gate alongside the count, guarding against oversized ids.
 */
const DEFAULT_MAX_IDENTITY_BYTES = 32 * 1024 * 1024;
/**
 * Cursor string length limit. With HMAC it stays far below 2Ki; anything longer is rejected as tampered/corrupt.
 */
const MAX_CURSOR_LENGTH = 2_048;

interface TranscriptBinding {
	runtimeId: string;
	generation: number;
	ref: SessionRef;
	transcriptRevision: number;
}

interface PinnedTranscriptView extends TranscriptBinding {
	id: string;
	entryIds: string[];
	/** Frozen projection for this revision; avoids rebuilding the full transcript for every page. */
	messagesByEntryId: ReadonlyMap<string, SessionMessage>;
	identityBytes: number;
	createdAt: number;
	lastAccessedAt: number;
	expiresAt: number;
}

interface TranscriptCursorPayload {
	v: 1;
	viewId: string;
	boundary: number;
	direction: TranscriptPageDirection;
	limit: number;
}

type TranscriptPagerErrorCode =
	| "TRANSCRIPT_CURSOR_INVALID"
	| "TRANSCRIPT_CURSOR_EXPIRED"
	| "TRANSCRIPT_VIEW_TOO_LARGE"
	| "TRANSCRIPT_ITEM_TOO_LARGE"
	| "TRANSCRIPT_REVISION_CONFLICT"
	| "STALE_RUNTIME_GENERATION";

type TranscriptPagerError = Error & {
	code: TranscriptPagerErrorCode;
};

function pagerError(code: TranscriptPagerErrorCode, message: string): TranscriptPagerError {
	return Object.assign(new Error(message), { code });
}

interface TranscriptPagerStats {
	views: number;
	identities: number;
	identityBytes: number;
}

export interface TranscriptPager {
	createEmptyTail(binding: TranscriptBinding): TranscriptPage;
	createTail(binding: TranscriptBinding, messages: readonly SessionMessage[]): TranscriptPage;
	readPage(binding: TranscriptBinding, request: ReadTranscriptPageRequest): TranscriptPage;
	invalidate(): void;
}

function bindingKey(binding: TranscriptBinding): string {
	return `${binding.runtimeId}\0${binding.generation}\0${sessionKey(binding.ref)}\0${binding.transcriptRevision}`;
}

/**
 * Deterministic view id from the transcript binding. randomUUID made every
 * invalidate()+createTail cycle mint a new id, so in-flight olderCursors from the
 * previous pin died with TRANSCRIPT_CURSOR_EXPIRED mid full-hydrate. Stable ids let a
 * re-pin after snapshotChanged serve the same cursor when revision is unchanged.
 */
function stableViewId(binding: TranscriptBinding): string {
	return createHash("sha256").update(bindingKey(binding)).digest("base64url");
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function indexDurableMessages(messages: readonly SessionMessage[]): {
	entryIds: string[];
	messagesByEntryId: ReadonlyMap<string, SessionMessage>;
} {
	const entryIds: string[] = [];
	const messagesByEntryId = new Map<string, SessionMessage>();
	for (const message of messages) {
		if (!message.entryId) continue;
		if (messagesByEntryId.has(message.entryId)) {
			throw pagerError("TRANSCRIPT_REVISION_CONFLICT", `Duplicate transcript entry identity: ${message.entryId}`);
		}
		messagesByEntryId.set(message.entryId, message);
		entryIds.push(message.entryId);
	}
	return { entryIds, messagesByEntryId };
}

function identityBytes(entryIds: readonly string[]): number {
	return entryIds.reduce((total, entryId) => total + Buffer.byteLength(entryId, "utf8") + 8, 0);
}

function cursorRecord(value: unknown): TranscriptCursorPayload | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<TranscriptCursorPayload>;
	if (
		candidate.v !== 1 ||
		typeof candidate.viewId !== "string" ||
		candidate.viewId.length === 0 ||
		!Number.isSafeInteger(candidate.boundary) ||
		(candidate.boundary as number) < 0 ||
		(candidate.direction !== "older" && candidate.direction !== "newer") ||
		!Number.isSafeInteger(candidate.limit) ||
		(candidate.limit as number) <= 0
	) {
		return null;
	}
	return candidate as TranscriptCursorPayload;
}

export function createTranscriptPager(): TranscriptPager {
	const now = Date.now;
	const pinTtlMs = DEFAULT_PIN_TTL_MS;
	const maxViews = DEFAULT_MAX_VIEWS;
	const maxIdentities = DEFAULT_MAX_IDENTITIES;
	const maxIdentityBytes = DEFAULT_MAX_IDENTITY_BYTES;
	const pageLimit = DEFAULT_PAGE_LIMIT;
	const pageMaxBytes = DEFAULT_PAGE_MAX_BYTES;
	const cursorSecret = Buffer.from(randomBytes(32));
	const views = new Map<string, PinnedTranscriptView>();
	const viewIdByBinding = new Map<string, string>();

	function removeView(view: PinnedTranscriptView): void {
		views.delete(view.id);
		const key = bindingKey(view);
		if (viewIdByBinding.get(key) === view.id) viewIdByBinding.delete(key);
	}

	function stats(): TranscriptPagerStats {
		let identities = 0;
		let bytes = 0;
		for (const view of views.values()) {
			identities += view.entryIds.length;
			bytes += view.identityBytes;
		}
		return { views: views.size, identities, identityBytes: bytes };
	}

	function prune(currentTime: number, protectedViewId?: string): void {
		for (const view of [...views.values()]) {
			if (view.id !== protectedViewId && view.expiresAt <= currentTime) removeView(view);
		}
		while (true) {
			const current = stats();
			if (
				current.views <= maxViews &&
				current.identities <= maxIdentities &&
				current.identityBytes <= maxIdentityBytes
			) {
				return;
			}
			let oldest: PinnedTranscriptView | null = null;
			for (const candidate of views.values()) {
				if (candidate.id === protectedViewId) continue;
				if (!oldest || candidate.lastAccessedAt < oldest.lastAccessedAt) oldest = candidate;
			}
			if (!oldest) {
				throw pagerError("TRANSCRIPT_VIEW_TOO_LARGE", "Transcript cursor view exceeds its bounded lease budget");
			}
			removeView(oldest);
		}
	}

	function viewFor(binding: TranscriptBinding, messages: readonly SessionMessage[]): PinnedTranscriptView {
		const currentTime = now();
		prune(currentTime);
		const key = bindingKey(binding);
		// A newer binding makes older cursors unusable; drop their projected payload immediately.
		for (const view of [...views.values()]) {
			if (sameSessionRef(view.ref, binding.ref) && bindingKey(view) !== key) removeView(view);
		}
		const existingId = viewIdByBinding.get(key);
		const { entryIds, messagesByEntryId } = indexDurableMessages(messages);
		if (existingId) {
			const existing = views.get(existingId);
			if (existing) {
				if (
					existing.entryIds.length !== entryIds.length ||
					existing.entryIds.some((entryId, index) => entryId !== entryIds[index])
				) {
					throw pagerError(
						"TRANSCRIPT_REVISION_CONFLICT",
						"Transcript contents changed without advancing transcriptRevision",
					);
				}
				existing.lastAccessedAt = currentTime;
				existing.expiresAt = currentTime + pinTtlMs;
				return existing;
			}
			viewIdByBinding.delete(key);
		}

		const bytes = identityBytes(entryIds);
		if (entryIds.length > maxIdentities || bytes > maxIdentityBytes) {
			throw pagerError("TRANSCRIPT_VIEW_TOO_LARGE", "Transcript identity view exceeds its per-owner budget");
		}
		const view: PinnedTranscriptView = {
			...binding,
			ref: { ...binding.ref },
			id: stableViewId(binding),
			entryIds,
			messagesByEntryId,
			identityBytes: bytes,
			createdAt: currentTime,
			lastAccessedAt: currentTime,
			expiresAt: currentTime + pinTtlMs,
		};
		views.set(view.id, view);
		viewIdByBinding.set(key, view.id);
		try {
			prune(currentTime, view.id);
		} catch (error) {
			removeView(view);
			throw error;
		}
		return view;
	}

	function signPayload(encodedPayload: string): Buffer {
		return createHmac("sha256", cursorSecret).update(encodedPayload).digest();
	}

	function encodeCursor(
		view: PinnedTranscriptView,
		boundary: number,
		direction: TranscriptPageDirection,
		limit: number,
	): string {
		const payload: TranscriptCursorPayload = { v: 1, viewId: view.id, boundary, direction, limit };
		const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
		return `${encodedPayload}.${signPayload(encodedPayload).toString("base64url")}`;
	}

	function decodeCursor(cursor: string): TranscriptCursorPayload {
		if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
			throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor has an invalid length");
		}
		const separator = cursor.indexOf(".");
		if (separator <= 0 || separator !== cursor.lastIndexOf(".")) {
			throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor has an invalid envelope");
		}
		const encodedPayload = cursor.slice(0, separator);
		const encodedSignature = cursor.slice(separator + 1);
		let signature: Buffer;
		let parsed: unknown;
		try {
			signature = Buffer.from(encodedSignature, "base64url");
			parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
		} catch {
			throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor cannot be decoded");
		}
		const expected = signPayload(encodedPayload);
		if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
			throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor signature is invalid");
		}
		const payload = cursorRecord(parsed);
		if (!payload) throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor payload is invalid");
		return payload;
	}

	function pageFromRange(view: PinnedTranscriptView, start: number, end: number, limit: number): TranscriptPage {
		const items: SessionMessage[] = [];
		for (const entryId of view.entryIds.slice(start, end)) {
			const message = view.messagesByEntryId.get(entryId);
			if (!message) {
				removeView(view);
				throw pagerError("TRANSCRIPT_CURSOR_EXPIRED", "Pinned transcript entry is no longer available");
			}
			items.push(message);
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			runtimeId: view.runtimeId,
			generation: view.generation,
			ref: { ...view.ref },
			transcriptRevision: view.transcriptRevision,
			items,
			limit,
			...(start > 0 ? { olderCursor: encodeCursor(view, start, "older", limit) } : {}),
			...(end < view.entryIds.length ? { newerCursor: encodeCursor(view, end, "newer", limit) } : {}),
			hasOlder: start > 0,
			hasNewer: end < view.entryIds.length,
		};
	}

	function boundedRange(
		view: PinnedTranscriptView,
		boundary: number,
		direction: TranscriptPageDirection,
		limit: number,
	): { start: number; end: number } {
		let bytes = 0;
		if (direction === "older") {
			let start = boundary;
			while (start > 0 && boundary - start < limit) {
				const entryId = view.entryIds[start - 1];
				const message = entryId ? view.messagesByEntryId.get(entryId) : undefined;
				if (!message) break;
				const nextBytes = serializedBytes(message);
				if (nextBytes > pageMaxBytes) {
					throw pagerError("TRANSCRIPT_ITEM_TOO_LARGE", `Transcript item exceeds ${pageMaxBytes} bytes`);
				}
				if (bytes + nextBytes > pageMaxBytes && start < boundary) break;
				bytes += nextBytes;
				start -= 1;
			}
			return { start, end: boundary };
		}

		let end = boundary;
		while (end < view.entryIds.length && end - boundary < limit) {
			const entryId = view.entryIds[end];
			const message = entryId ? view.messagesByEntryId.get(entryId) : undefined;
			if (!message) break;
			const nextBytes = serializedBytes(message);
			if (nextBytes > pageMaxBytes) {
				throw pagerError("TRANSCRIPT_ITEM_TOO_LARGE", `Transcript item exceeds ${pageMaxBytes} bytes`);
			}
			if (bytes + nextBytes > pageMaxBytes && end > boundary) break;
			bytes += nextBytes;
			end += 1;
		}
		return { start: boundary, end };
	}

	function tailItems(messages: readonly SessionMessage[]): SessionMessage[] {
		const items: SessionMessage[] = [];
		let bytes = 0;
		for (let index = messages.length - 1; index >= 0 && items.length < pageLimit; index -= 1) {
			const message = messages[index];
			if (!message) continue;
			const nextBytes = serializedBytes(message);
			if (nextBytes > pageMaxBytes) {
				throw pagerError("TRANSCRIPT_ITEM_TOO_LARGE", `Transcript item exceeds ${pageMaxBytes} bytes`);
			}
			if (bytes + nextBytes > pageMaxBytes && items.length > 0) break;
			bytes += nextBytes;
			items.unshift(message);
		}
		return items;
	}

	return {
		createEmptyTail(binding) {
			return {
				protocolVersion: PROTOCOL_VERSION,
				runtimeId: binding.runtimeId,
				generation: binding.generation,
				ref: { ...binding.ref },
				transcriptRevision: binding.transcriptRevision,
				items: [],
				limit: pageLimit,
				hasOlder: false,
				hasNewer: false,
			};
		},
		createTail(binding, messages) {
			const view = viewFor(binding, messages);
			const items = tailItems(messages);
			const firstDurable = items.find((message) => message.entryId)?.entryId;
			const olderBoundary = firstDurable ? view.entryIds.indexOf(firstDurable) : view.entryIds.length;
			if (firstDurable && olderBoundary < 0) {
				throw pagerError("TRANSCRIPT_REVISION_CONFLICT", "Transcript tail is absent from its pinned identity view");
			}
			return {
				protocolVersion: PROTOCOL_VERSION,
				runtimeId: binding.runtimeId,
				generation: binding.generation,
				ref: { ...binding.ref },
				transcriptRevision: binding.transcriptRevision,
				items,
				limit: pageLimit,
				...(olderBoundary > 0 ? { olderCursor: encodeCursor(view, olderBoundary, "older", pageLimit) } : {}),
				hasOlder: olderBoundary > 0,
				hasNewer: false,
			};
		},
		readPage(binding, request) {
			if (
				request.runtimeId !== binding.runtimeId ||
				request.generation !== binding.generation ||
				!sameSessionRef(request.ref, binding.ref)
			) {
				throw pagerError("STALE_RUNTIME_GENERATION", "Transcript request targets a stale runtime binding");
			}
			const payload = decodeCursor(request.cursor);
			if (payload.direction !== request.direction || payload.limit !== request.limit) {
				throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor policy does not match the request");
			}
			const view = views.get(payload.viewId);
			const currentTime = now();
			if (!view || view.expiresAt <= currentTime) {
				if (view) removeView(view);
				throw pagerError("TRANSCRIPT_CURSOR_EXPIRED", "Transcript cursor lease expired");
			}
			if (
				view.runtimeId !== binding.runtimeId ||
				view.generation !== binding.generation ||
				!sameSessionRef(view.ref, binding.ref) ||
				view.transcriptRevision !== request.expectedTranscriptRevision
			) {
				throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor binding does not match the request");
			}
			if (payload.boundary > view.entryIds.length) {
				throw pagerError("TRANSCRIPT_CURSOR_INVALID", "Transcript cursor boundary is outside the pinned view");
			}
			view.lastAccessedAt = currentTime;
			view.expiresAt = currentTime + pinTtlMs;
			const range = boundedRange(view, payload.boundary, payload.direction, payload.limit);
			return pageFromRange(view, range.start, range.end, payload.limit);
		},
		invalidate() {
			views.clear();
			viewIdByBinding.clear();
		},
	};
}
