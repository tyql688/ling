import type { DatasetStoreIssueStatus } from "@ling/contracts/dataset-status";
import { isRecord as isDatasetRecord } from "@ling/contracts/records";

type DatasetReadErrorCode = "DATASET_CORRUPT" | "DATASET_FUTURE_VERSION";

export class DatasetReadError extends Error {
	readonly code: DatasetReadErrorCode;
	readonly datasetId: string;
	readonly filePath: string | null;
	readonly foundVersion: number | null;

	constructor(options: {
		code: DatasetReadErrorCode;
		datasetId: string;
		message: string;
		filePath?: string;
		foundVersion?: number;
		cause?: unknown;
	}) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "DatasetReadError";
		this.code = options.code;
		this.datasetId = options.datasetId;
		this.filePath = options.filePath ?? null;
		this.foundVersion = options.foundVersion ?? null;
	}
}

export function isRecoverableDatasetReadError(error: unknown): error is DatasetReadError {
	return error instanceof DatasetReadError;
}

export function datasetStoreStatusFromError(error: unknown): DatasetStoreIssueStatus {
	if (!(error instanceof DatasetReadError)) {
		return { status: "unavailable", errorCode: "DATASET_READ_FAILED" };
	}
	return {
		status: "recoveryRequired",
		errorCode: error.code,
		foundVersion:
			error.code === "DATASET_FUTURE_VERSION" && Number.isSafeInteger(error.foundVersion) ? error.foundVersion : null,
	};
}

interface DatasetVersionPolicy {
	datasetId: string;
	schema: string;
	currentVersion: number;
	/** Oldest version this build still reads (upgrade path). Absent: only currentVersion. */
	minSupportedVersion?: number;
	filePath?: string;
}

export function parseDatasetJson(source: string, datasetId: string, filePath?: string): unknown {
	try {
		return JSON.parse(source) as unknown;
	} catch (cause) {
		throw new DatasetReadError({
			code: "DATASET_CORRUPT",
			datasetId,
			message: `The ${datasetId} dataset is not valid JSON.`,
			...(filePath !== undefined ? { filePath } : {}),
			cause,
		});
	}
}

export function inspectDatasetVersion(value: unknown, policy: DatasetVersionPolicy): void {
	if (!isDatasetRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) {
		throw new DatasetReadError({
			code: "DATASET_CORRUPT",
			datasetId: policy.datasetId,
			message: `The ${policy.datasetId} dataset has no valid schema version.`,
			...(policy.filePath !== undefined ? { filePath: policy.filePath } : {}),
		});
	}
	const version = value.version as number;
	if (version > policy.currentVersion) {
		throw new DatasetReadError({
			code: "DATASET_FUTURE_VERSION",
			datasetId: policy.datasetId,
			message: `The ${policy.datasetId} dataset uses future version ${version}; this build supports ${policy.currentVersion}.`,
			foundVersion: version,
			...(policy.filePath !== undefined ? { filePath: policy.filePath } : {}),
		});
	}
	const minSupported = policy.minSupportedVersion ?? policy.currentVersion;
	if (version >= minSupported && version <= policy.currentVersion) {
		if (value.schema !== policy.schema) {
			throw new DatasetReadError({
				code: "DATASET_CORRUPT",
				datasetId: policy.datasetId,
				message: `The ${policy.datasetId} dataset schema identity is invalid.`,
				foundVersion: version,
				...(policy.filePath !== undefined ? { filePath: policy.filePath } : {}),
			});
		}
		return;
	}
	throw new DatasetReadError({
		code: "DATASET_CORRUPT",
		datasetId: policy.datasetId,
		message: `The ${policy.datasetId} dataset version ${version} is unsupported.`,
		foundVersion: version,
		...(policy.filePath !== undefined ? { filePath: policy.filePath } : {}),
	});
}

export function datasetCorruption(
	datasetId: string,
	message: string,
	options: { filePath?: string; cause?: unknown } = {},
): DatasetReadError {
	return new DatasetReadError({
		code: "DATASET_CORRUPT",
		datasetId,
		message,
		...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
		...(options.cause !== undefined ? { cause: options.cause } : {}),
	});
}
