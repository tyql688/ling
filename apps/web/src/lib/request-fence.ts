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

/** Accepts an asynchronous result when its request and identity are still current. A newer request, invalidation or identity change rejects the earlier result. */
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
