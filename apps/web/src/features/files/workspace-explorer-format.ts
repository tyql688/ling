import type { GitChangedFileStatus } from "@ling/contracts/git";

/** Text line count: an empty file has 0 lines; a trailing newline doesn't add one. */
export function countTextLines(content: string): number {
	if (content.length === 0) return 0;
	return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

export function formatWorkspaceFileSize(bytes: number, locale: string): string {
	if (bytes < 1_024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"] as const;
	let value = bytes / 1_024;
	let unitIndex = 0;
	while (value >= 1_024 && unitIndex < units.length - 1) {
		value /= 1_024;
		unitIndex += 1;
	}
	const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unitIndex]}`;
}

export function gitStatusLabel(status: GitChangedFileStatus): string {
	switch (status) {
		case "modified":
			return "M";
		case "added":
			return "A";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		case "copied":
			return "C";
		case "untracked":
			return "U";
		case "conflicted":
			return "!";
	}
}

export function gitStatusClass(status: GitChangedFileStatus): string {
	switch (status) {
		case "added":
		case "untracked":
			return "text-git-added";
		case "deleted":
		case "conflicted":
			return "text-git-deleted";
		case "renamed":
		case "copied":
			return "text-git-renamed";
		case "modified":
			return "text-git-modified";
	}
}
