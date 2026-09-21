import type { DatasetStoreStatus } from "@ling/contracts/dataset-status";

interface DatasetStoreIssue {
	message: string;
	recoverable: boolean;
}

export function datasetStoreIssue(
	status: DatasetStoreStatus,
	translate: (key: string, options?: { version?: number | null }) => string,
): DatasetStoreIssue | null {
	if (status.status === "ready") return null;
	if (status.status === "unavailable") {
		return { message: translate("dataset.readUnavailable"), recoverable: false };
	}
	if (status.errorCode === "DATASET_FUTURE_VERSION") {
		return {
			message: translate("dataset.futureVersion", { version: status.foundVersion }),
			recoverable: true,
		};
	}
	return { message: translate("dataset.corrupt"), recoverable: true };
}
