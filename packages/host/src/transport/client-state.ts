import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";

export interface HostClientState {
	claimSession(clientId: string, ref: SessionRef): void;
	ownerOfSession(ref: SessionRef): string | null;
	assertCanRespond(clientId: string, ref: SessionRef): void;
	setViewedSession(clientId: string, ref: SessionRef | null): void;
	viewedSessionRefs(): SessionRef[];
	disconnect(clientId: string): void;
}

export function createHostClientState(): HostClientState {
	const owners = new Map<string, string>();
	const viewed = new Map<string, SessionRef>();
	return {
		claimSession: (clientId, ref) => owners.set(sessionKey(ref), clientId),
		ownerOfSession: (ref) => owners.get(sessionKey(ref)) ?? null,
		assertCanRespond: (clientId, ref) => {
			const key = sessionKey(ref);
			const owner = owners.get(key);
			if (owner !== undefined && owner !== clientId) {
				throw new Error("This interaction belongs to another Ling client");
			}
			owners.set(key, clientId);
		},
		setViewedSession: (clientId, ref) => {
			if (ref === null) viewed.delete(clientId);
			else viewed.set(clientId, { ...ref });
		},
		viewedSessionRefs: () => [...viewed.values()].map((ref) => ({ ...ref })),
		disconnect: (clientId) => {
			viewed.delete(clientId);
			for (const [key, owner] of owners) {
				if (owner === clientId) owners.delete(key);
			}
		},
	};
}
