import type { SessionMessage, SessionRef } from "@ling/contracts/session";

type SessionTranscriptProjectionCacheWriteResult = "written" | "projectionTooLarge";

export interface SessionTranscriptProjectionCache {
	read(ref: SessionRef, cacheKey: string): Promise<readonly SessionMessage[] | null>;
	write(
		ref: SessionRef,
		cacheKey: string,
		messages: readonly SessionMessage[],
	): Promise<SessionTranscriptProjectionCacheWriteResult>;
	delete(ref: SessionRef): Promise<void>;
}
