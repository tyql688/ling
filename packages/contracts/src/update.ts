export interface UpdateState {
	appVersion: string;
	/** False in unpackaged development builds because no update channel is available. */
	supported: boolean;
	/** Latest native update state, including events emitted before the settings view mounted. */
	event: UpdateEvent | null;
}

export type UpdateEvent =
	| { type: "checking" }
	| { type: "not-available" }
	| { type: "available"; version: string }
	| { type: "download-progress"; percent: number }
	| { type: "downloaded"; version: string }
	| { type: "installing" }
	| { type: "error"; message: string; restartRequired?: boolean };
