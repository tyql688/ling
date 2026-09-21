import { sessionMessageRowIdentity } from "@renderer/features/sessions/runtime/session-message-identity";
import type { TimelineRow } from "./transcript-activity-model";

type TranscriptRowIdentityInput =
	| TimelineRow
	| {
			kind: "turnFold";
			turnKey: string;
			expanded: boolean;
			durationMs?: number | null;
			outcome: string;
			hiddenCount: number;
	  }
	| { kind: "turnChanges"; turnId: string };

function timelineRowId(row: TimelineRow): string {
	if (row.kind === "activity") return `activity:${row.keyId}`;
	return sessionMessageRowIdentity(row.message);
}

export function transcriptRowId(row: TranscriptRowIdentityInput): string {
	if (row.kind === "turnFold") return `turn-fold:${row.turnKey}`;
	if (row.kind === "turnChanges") return `turn-changes:${row.turnId}`;
	return timelineRowId(row);
}
