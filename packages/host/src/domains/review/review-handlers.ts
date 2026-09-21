import { changeReviewProcedures } from "@ling/contracts/change-review-procedures";
import { isLingError } from "@ling/core/ling-error";
import { assertKnownWorkspaceRoot } from "@ling/host/domains/projects/workspace-paths";
import type { ChangeReviewOperationRegistry } from "@ling/host/domains/review/operations";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import type { ChangeReviewHost } from "./change-review";

export function createChangeReviewDomain({
	review,
	changeReviewDiffOperations,
	openProjectPaths,
}: {
	review: ChangeReviewHost;
	changeReviewDiffOperations: ChangeReviewOperationRegistry;
	openProjectPaths: () => string[];
}): HostDomain {
	const {
		commitChangeReview,
		discardChangeReview,
		getChangeReviewDiff,
		getChangeReviewSnapshot,
		getChangeReviewStateStatus,
		resetChangeReviewState,
		revertChangeReviewTurn,
	} = review;

	const handlers: HostHandlers = {
		[changeReviewProcedures.getSnapshot.channel]: async (_context, ref) => {
			assertKnownWorkspaceRoot(ref.cwd, openProjectPaths());
			try {
				return await getChangeReviewSnapshot(ref);
			} catch (error) {
				// A typed failure already names its cause; wrapping it would hide, for example,
				// a deleted project folder behind an unactionable internal error.
				if (isLingError(error)) throw error;
				throw new Error("Ling could not read change review state", { cause: error });
			}
		},

		[changeReviewProcedures.revertTurn.channel]: async (_context, request) => {
			assertKnownWorkspaceRoot(request.ref.cwd, openProjectPaths());
			return revertChangeReviewTurn(request);
		},

		[changeReviewProcedures.stateStatus.channel]: async (_context, ref) => {
			assertKnownWorkspaceRoot(ref.cwd, openProjectPaths());
			return getChangeReviewStateStatus(ref);
		},

		[changeReviewProcedures.resetState.channel]: async (_context, ref) => {
			assertKnownWorkspaceRoot(ref.cwd, openProjectPaths());
			return resetChangeReviewState(ref);
		},

		[changeReviewProcedures.getDiff.channel]: async (_context, request) => {
			assertKnownWorkspaceRoot(request.ref.cwd, openProjectPaths());
			const operation = changeReviewDiffOperations.start(request);
			return operation.run(async (signal) => ({
				requestId: request.operation.requestId,
				...(await getChangeReviewDiff(request, signal)),
			}));
		},

		[changeReviewProcedures.cancelDiff.channel]: async (_context, request) => {
			return (async () => changeReviewDiffOperations.cancel(request))();
		},

		[changeReviewProcedures.commit.channel]: async (_context, request) => {
			assertKnownWorkspaceRoot(request.ref.cwd, openProjectPaths());
			return commitChangeReview(request);
		},

		[changeReviewProcedures.discard.channel]: async (_context, request) => {
			assertKnownWorkspaceRoot(request.ref.cwd, openProjectPaths());
			return discardChangeReview(request);
		},
	};
	return { handlers };
}
