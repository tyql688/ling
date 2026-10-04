/** A health report stays small enough to render even when a whole dataset is damaged. */
export const DATA_HEALTH_ISSUE_LIMIT = 100;
export interface DataStoreIssue {
	key: string;
	source: string;
	message: string;
}

/** Reports durable Host data health, including separate results for each legacy dataset import. */
export interface DataStoreHealth {
	status: "ready" | "degraded" | "unavailable";
	path: string;
	message: string | null;
	issues: DataStoreIssue[];
	omittedIssues: number;
}
