import type { PiResourceReloadSummary } from "@ling/contracts/session";

type PiResourceReloadStatus = "success" | "deferred" | "error";

export function summarizePiResourceReload(summary: PiResourceReloadSummary): PiResourceReloadStatus {
	const deferred = summary.sessions?.deferred ?? 0;
	const failed =
		(summary.projectError === null ? 0 : 1) +
		(summary.sessionError === null ? 0 : 1) +
		(summary.sessions?.failed.length ?? 0) +
		(summary.sessions?.failedOmitted ?? 0);
	if (failed > 0) return "error";
	if (deferred > 0) return "deferred";
	return "success";
}
