type DatasetRecoveryErrorCode = "DATASET_CORRUPT" | "DATASET_FUTURE_VERSION";

export type DatasetStoreStatus =
	| { status: "ready" }
	| {
			status: "recoveryRequired";
			errorCode: DatasetRecoveryErrorCode;
			foundVersion: number | null;
	  }
	| { status: "unavailable"; errorCode: "DATASET_READ_FAILED" };

export type DatasetStoreIssueStatus = Exclude<DatasetStoreStatus, { status: "ready" }>;
