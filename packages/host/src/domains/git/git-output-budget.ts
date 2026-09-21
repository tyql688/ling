import { throwIfOperationAborted } from "@ling/core/ling-error";

/** Stable error code thrown when the diff output budget is exceeded; callers branch on code, never on message text. */
const GIT_DIFF_OUTPUT_LIMIT_ERROR_CODE = "GIT_DIFF_OUTPUT_LIMIT";

interface GitDiffOutputLimitError extends Error {
	readonly code: typeof GIT_DIFF_OUTPUT_LIMIT_ERROR_CODE;
	readonly limitBytes: number;
}

export interface GitOutputBudget {
	readonly limitBytes: number;
	usedBytes: number;
	exceeded: boolean;
}

interface GitOutputObserver {
	readonly signal: AbortSignal;
	record(byteLength: number): void;
}

function createGitDiffOutputLimitError(limitBytes: number): GitDiffOutputLimitError {
	return Object.assign(new Error(`Git diff output exceeded ${limitBytes} bytes`), {
		name: "GitDiffOutputLimitError",
		// The assertion pins the literal type; without it Object.assign widens `code` to string and the
		// result no longer satisfies GitDiffOutputLimitError under exactOptionalPropertyTypes (TS2375).
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- see above
		code: GIT_DIFF_OUTPUT_LIMIT_ERROR_CODE as typeof GIT_DIFF_OUTPUT_LIMIT_ERROR_CODE,
		limitBytes,
	});
}

export function createGitOutputBudget(limitBytes: number): GitOutputBudget {
	if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error("Invalid Git output byte limit");
	return { limitBytes, usedBytes: 0, exceeded: false };
}

/** Runs one Git command against a budget that may be shared by several sequential
 * commands. A fresh controller is used for every command, so a limit failure cannot
 * poison a later, independent Git operation. */
export async function readBoundedGitOutput(
	budget: GitOutputBudget,
	execute: (observer: GitOutputObserver) => Promise<string>,
	ownerSignal?: AbortSignal,
): Promise<string> {
	throwIfOperationAborted(ownerSignal);
	if (budget.exceeded) throw createGitDiffOutputLimitError(budget.limitBytes);
	const controller = new AbortController();
	const signal = ownerSignal ? AbortSignal.any([ownerSignal, controller.signal]) : controller.signal;
	const record = (byteLength: number): void => {
		if (budget.exceeded) return;
		if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("Invalid Git output chunk size");
		budget.usedBytes += byteLength;
		if (budget.usedBytes <= budget.limitBytes) return;
		budget.exceeded = true;
		controller.abort();
	};
	try {
		throwIfOperationAborted(ownerSignal);
		const output = await execute({ signal, record });
		if (budget.exceeded) throw createGitDiffOutputLimitError(budget.limitBytes);
		return output;
	} catch (error) {
		if (budget.exceeded) throw createGitDiffOutputLimitError(budget.limitBytes);
		throwIfOperationAborted(ownerSignal);
		throw error;
	}
}
