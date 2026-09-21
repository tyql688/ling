import { createChangeReviewCaptureOwner } from "./change-review-capture";
import { createChangeReviewMutationOwner } from "./change-review-mutations";
import { createChangeReviewQueryOwner } from "./change-review-query";
import { createChangeReviewRuntimeOwner } from "./change-review-runtime";
import type { ChangeReviewStore } from "./change-review-store";

import type { ProjectFileWatchers } from "@ling/host/domains/review/project-file-watcher";
import type { PiWorkerClient } from "../../workers/pi/pi-worker-client";
import type { GitWriteQueue } from "../git/git-write-queue";
export function createChangeReviewHost({
	store,
	withProject,
	watchers,
	gitWrites,
}: {
	withProject: PiWorkerClient["withProject"];
	watchers: ProjectFileWatchers;
	gitWrites: GitWriteQueue;
	store: ChangeReviewStore;
}) {
	const runtime = createChangeReviewRuntimeOwner({ withProject, watchers, store });
	const capture = createChangeReviewCaptureOwner(runtime, store.persist);
	const query = createChangeReviewQueryOwner(runtime, store);
	const mutations = createChangeReviewMutationOwner(runtime, gitWrites, store.persist);

	const changeReviewTurnLifecycleHost = capture.turnLifecycleHost;
	const recordChangeReviewFileUpdate = capture.recordFileUpdate;
	const recordChangeReviewTrackingFailure = capture.recordTrackingFailure;

	const getChangeReviewSnapshot = query.getSnapshot;
	const getChangeReviewStateStatus = query.getStateStatus;
	const resetChangeReviewState = query.resetState;
	const getChangeReviewDiff = query.getDiff;

	const onChangeReviewLiveUpdate = runtime.onLiveUpdate;
	const releaseChangeReviewSession = runtime.releaseSession;
	const releaseChangeReviewProject = runtime.releaseProject;
	const deleteChangeReviewSessionState = runtime.deleteSessionState;
	const initializeChangeReviewInfrastructure = runtime.initialize;
	const shutdownChangeReviewInfrastructure = runtime.shutdown;

	const commitChangeReview = mutations.commit;
	const revertChangeReviewTurn = mutations.revertTurn;
	const discardChangeReview = mutations.discard;

	return {
		changeReviewTurnLifecycleHost,
		recordChangeReviewFileUpdate,
		recordChangeReviewTrackingFailure,
		getChangeReviewSnapshot,
		getChangeReviewStateStatus,
		resetChangeReviewState,
		getChangeReviewDiff,
		onChangeReviewLiveUpdate,
		releaseChangeReviewSession,
		releaseChangeReviewProject,
		deleteChangeReviewSessionState,
		initializeChangeReviewInfrastructure,
		shutdownChangeReviewInfrastructure,
		commitChangeReview,
		revertChangeReviewTurn,
		discardChangeReview,
	};
}
export type ChangeReviewHost = ReturnType<typeof createChangeReviewHost>;
