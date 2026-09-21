import { argumentsOf, event, request, returns } from "./procedure";
import type { SessionRef } from "./session-ref";
import type {
	CancelChangeReviewDiffRequest,
	CancelChangeReviewDiffResponse,
	ChangeReviewDiffRequest,
	ChangeReviewDiffResponse,
	ChangeReviewSnapshot,
	ChangeReviewStateStatus,
	ChangeReviewTrackingEvent,
	CommitChangeReviewRequest,
	DiscardChangeReviewRequest,
	GitCommitResult,
	GitStatus,
	RevertChangeReviewTurnRequest,
} from "./git";
import { createGitRequestSchemas } from "./git-requests";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
export function createChangeReviewProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const schemas = createGitRequestSchemas(paths.absolute, paths.isAbsolute, paths.windows);
	return {
		onTrackingEvent: event("changes:tracking-event", returns<ChangeReviewTrackingEvent>()),
		getSnapshot: request(
			"changes:getSnapshot",
			argumentsOf<[ref: SessionRef]>((args) => [schemas.changeReviewRefRequestSchema.parse(args[0])]),
			returns<ChangeReviewSnapshot>(),
		),
		stateStatus: request(
			"changes:stateStatus",
			argumentsOf<[ref: SessionRef]>((args) => [schemas.changeReviewRefRequestSchema.parse(args[0])]),
			returns<ChangeReviewStateStatus>(),
		),
		resetState: request(
			"changes:resetState",
			argumentsOf<[ref: SessionRef]>((args) => [schemas.changeReviewRefRequestSchema.parse(args[0])]),
			returns<ChangeReviewSnapshot>(),
		),
		getDiff: request(
			"changes:getDiff",
			argumentsOf<[request: ChangeReviewDiffRequest]>((args) => [schemas.changeReviewDiffRequestSchema.parse(args[0])]),
			returns<ChangeReviewDiffResponse>(),
		),
		cancelDiff: request(
			"changes:cancelDiff",
			argumentsOf<[request: CancelChangeReviewDiffRequest]>((args) => [
				schemas.cancelChangeReviewDiffRequestSchema.parse(args[0]),
			]),
			returns<CancelChangeReviewDiffResponse>(),
		),
		commit: request(
			"changes:commit",
			argumentsOf<[request: CommitChangeReviewRequest]>((args) => [
				schemas.commitChangeReviewRequestSchema.parse(args[0]),
			]),
			returns<GitCommitResult>(),
		),
		discard: request(
			"changes:discard",
			argumentsOf<[request: DiscardChangeReviewRequest]>((args) => [
				schemas.discardChangeReviewRequestSchema.parse(args[0]),
			]),
			returns<GitStatus>(),
		),
		revertTurn: request(
			"changes:revertTurn",
			argumentsOf<[request: RevertChangeReviewTurnRequest]>((args) => [
				schemas.revertChangeReviewTurnRequestSchema.parse(args[0]),
			]),
			returns<void>(),
		),
	};
}
export const changeReviewProcedures = createChangeReviewProcedures();
