interface TranscriptPageLoadCoordinator {
	run(load: () => Promise<boolean>): Promise<boolean>;
	reset(): void;
}

/** Shares one transcript-page read between scroll restoration and full-history search. */
export function createTranscriptPageLoadCoordinator(): TranscriptPageLoadCoordinator {
	let inFlight: Promise<boolean> | null = null;
	return {
		run(load) {
			if (inFlight) return inFlight;
			const request = load();
			inFlight = request;
			const clear = () => {
				if (inFlight === request) inFlight = null;
			};
			void request.then(clear, clear);
			return request;
		},
		reset() {
			inFlight = null;
		},
	};
}
