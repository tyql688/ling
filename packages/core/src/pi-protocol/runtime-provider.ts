import type { SessionCatalogFileFingerprint, SessionCatalogInfo, SessionCatalogDiscovery } from "./runtime-types";
import type { SessionRef, ThinkingLevel } from "@ling/contracts/session";
import type { SessionRuntimeForkSource, SessionRuntimePort } from "./runtime-port";

export type SessionRuntimeBindingCleanup = () => void;
export type BeforeBindSession = (
	ref: SessionRef,
) => SessionRuntimeBindingCleanup | undefined | Promise<SessionRuntimeBindingCleanup | undefined>;

export interface CreateSessionRuntimeOptions {
	beforeBind?: BeforeBindSession;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

export interface SessionRuntimeProvider {
	resolveProject(cwd: string): string;
	listSessions(cwd: string): Promise<SessionCatalogInfo[]>;
	discoverSessions(
		cwd: string,
		cachedFiles: readonly { path: string; fingerprint: SessionCatalogFileFingerprint }[],
	): Promise<SessionCatalogDiscovery[]>;
	create(cwd: string, options?: CreateSessionRuntimeOptions): Promise<SessionRuntimePort>;
	resume(
		cwd: string,
		sessionFilePath: string,
		createdAt: number,
		options?: { beforeBind?: BeforeBindSession },
	): Promise<SessionRuntimePort>;
	fork(
		source: SessionRuntimeForkSource,
		entryId: string,
		title: string,
		options?: { beforeBind?: BeforeBindSession },
	): Promise<SessionRuntimePort>;
}
