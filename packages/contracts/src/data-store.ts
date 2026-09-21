/** A health report stays small enough to render even when a whole dataset is damaged. */
export const DATA_HEALTH_ISSUE_LIMIT = 100;
export interface DataStoreIssue {
	key: string;
	source: string;
	message: string;
}

/** One health surface for Host-owned durable state. A damaged legacy dataset does not invalidate other imports. */
export interface DataStoreHealth {
	status: "ready" | "degraded" | "unavailable";
	path: string;
	message: string | null;
	issues: DataStoreIssue[];
	omittedIssues: number;
}
