/** Token issued by {@link createRequestFence}; opaque to callers. */
interface RequestFenceToken<Identity> {
	revision: number;
	identity: Identity;
}

export interface RequestFence<Identity> {
	begin(identity: Identity): RequestFenceToken<Identity>;
	invalidate(): void;
	isCurrent(token: RequestFenceToken<Identity>, current: Identity | null): boolean;
}

/**
 * Latest-wins fence for async responses that publish into shared UI state. A response
 * may only land when no newer request, explicit invalidation, or identity change has
 * happened since it started — so a slow reply can never overwrite a fresher one, and a
 * value fetched for one identity can never render against another.
 */
export function createRequestFence<Identity>(): RequestFence<Identity> {
	let revision = 0;
	return {
		begin(identity) {
			revision += 1;
			return { revision, identity };
		},
		invalidate() {
			revision += 1;
		},
		isCurrent(token, current) {
			return token.revision === revision && token.identity === current;
		},
	};
}
