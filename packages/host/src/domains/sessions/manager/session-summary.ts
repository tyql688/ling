import {
	SESSION_SUMMARY_PREVIEW_MAX_CHARS,
	SESSION_TITLE_MAX_CHARS,
	type SessionRef,
	type SessionSummary,
} from "@ling/contracts/session";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type { SessionCatalogFileFingerprint, SessionCatalogInfo } from "@ling/core/pi-protocol/runtime-types";

export interface ListedSessionSummary extends SessionSummary {
	sessionFilePath: string;
	parentSessionFilePath?: string;
	manualFork?: boolean;
	/** Present only when the summary was read from one stable physical-file generation. */
	sourceFingerprint?: SessionCatalogFileFingerprint;
}

type ListedSessionSource = SessionCatalogInfo;

interface ManagedSessionSummarySource {
	ref: SessionRef;
	runtime: SessionRuntimePort;
	cwd: string;
	createdAt: number;
	placeholderTitle: string;
}

export function projectSessionSummaryText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const boundary = value.charCodeAt(maxLength - 1);
	const endsWithHighSurrogate = boundary >= 0xd800 && boundary <= 0xdbff;
	return value.slice(0, endsWithHighSurrogate ? maxLength - 1 : maxLength);
}

export function hasListedSessionName(name: string | undefined): name is string {
	return typeof name === "string" && name.trim().length > 0;
}

export function projectListedSessionTitle(name: string | undefined, firstMessage: string): string {
	const title = hasListedSessionName(name) ? name : firstMessage;
	return projectSessionSummaryText(title, SESSION_TITLE_MAX_CHARS);
}

export function projectListedSessionSummary(
	cwd: string,
	info: ListedSessionSource,
	sourceFingerprint?: SessionCatalogFileFingerprint,
): ListedSessionSummary {
	return {
		id: info.id,
		cwd,
		sessionFilePath: info.path,
		...(info.parentSessionPath ? { parentSessionFilePath: info.parentSessionPath } : {}),
		...(info.manualFork === undefined ? {} : { manualFork: info.manualFork }),
		...(sourceFingerprint ? { sourceFingerprint } : {}),
		// Untitled sessions fall back to their first message; a blank title is localized
		// by the renderer as the product's new-session label.
		title: projectListedSessionTitle(info.name, info.firstMessage),
		createdAt: info.createdAt,
		// A new fork can contain copied messages older than its own session header.
		updatedAt: Math.max(info.createdAt, info.modifiedAt),
		messageCount: info.messageCount,
		preview: projectSessionSummaryText(info.firstMessage, SESSION_SUMMARY_PREVIEW_MAX_CHARS),
	};
}

export function projectManagedSessionSummary(source: ManagedSessionSummarySource): ListedSessionSummary {
	const summary = source.runtime.summarize(source.createdAt, source.placeholderTitle);
	return {
		id: source.ref.sessionId,
		cwd: source.cwd,
		sessionFilePath: summary.sessionFilePath,
		...(summary.parentSessionFilePath ? { parentSessionFilePath: summary.parentSessionFilePath } : {}),
		...(summary.manualFork === undefined ? {} : { manualFork: summary.manualFork }),
		title: projectSessionSummaryText(summary.title, SESSION_TITLE_MAX_CHARS),
		createdAt: source.createdAt,
		updatedAt: summary.updatedAt,
		messageCount: summary.messageCount,
		preview: projectSessionSummaryText(summary.preview, SESSION_SUMMARY_PREVIEW_MAX_CHARS),
	};
}
