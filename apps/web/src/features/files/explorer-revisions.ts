/**
 * Refresh revision strings for the explorer panel: the tree re-reads when any file's
 * identity/status changes, the preview when contents or counts change. Control-character
 * separators keep distinct file lists from colliding.
 */
export function explorerRefreshRevisions(
	reviewFiles: readonly {
		path: string;
		status: string;
		from?: string | undefined;
		contentTag?: string | undefined;
		additions?: number | undefined;
		deletions?: number | undefined;
	}[],
	gitFiles: readonly {
		path: string;
		status: string;
		from?: string | undefined;
		additions?: number | undefined;
		deletions?: number | undefined;
	}[],
): { tree: string; preview: string } {
	const reviewTreeRevision = reviewFiles
		.map((file) => [file.path, file.status, file.from].join("\u0001"))
		.join("\u0000");
	const gitTreeRevision = gitFiles.map((file) => [file.path, file.status, file.from].join("\u0001")).join("\u0000");
	const reviewPreviewRevision = reviewFiles
		.map((file) => [file.path, file.contentTag, file.additions, file.deletions].join("\u0001"))
		.join("\u0000");
	const gitPreviewRevision = gitFiles
		.map((file) => [file.path, file.additions, file.deletions].join("\u0001"))
		.join("\u0000");
	return {
		tree: `${reviewTreeRevision}\u0002${gitTreeRevision}`,
		preview: `${reviewPreviewRevision}\u0002${gitPreviewRevision}`,
	};
}
