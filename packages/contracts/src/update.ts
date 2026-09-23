export interface UpdateState {
	appVersion: string;
	/** Whether this build can check, download and install native updates. */
	supported: boolean;
	/** Release page for packaged builds distributed through manual installation. */
	manualDownloadUrl?: string;
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
