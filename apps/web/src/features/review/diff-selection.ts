import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";

/** Keep attached review excerpts bounded even when a whole file is selected. */
const EXCERPT_MAX_LINES = 40;

interface DiffRow {
	oldLine: number | null;
	newLine: number | null;
	text: string;
}

function lineAt(lines: string[], index: number): string {
	const line = lines[index];
	if (line === undefined) throw new Error("Diff line is outside the displayed document");
	return line;
}

function* diffRows(diff: FileDiffMetadata): Generator<DiffRow> {
	let oldLine = 1;
	let newLine = 1;
	for (const hunk of diff.hunks) {
		if (!diff.isPartial) {
			while (newLine < hunk.additionStart && oldLine < hunk.deletionStart) {
				yield { oldLine, newLine, text: ` ${lineAt(diff.additionLines, newLine - 1)}` };
				oldLine += 1;
				newLine += 1;
			}
		}
		oldLine = hunk.deletionStart;
		newLine = hunk.additionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === "context") {
				for (let index = 0; index < content.lines; index += 1) {
					yield { oldLine, newLine, text: ` ${lineAt(diff.additionLines, content.additionLineIndex + index)}` };
					oldLine += 1;
					newLine += 1;
				}
			} else {
				for (let index = 0; index < content.deletions; index += 1) {
					yield { oldLine, newLine: null, text: `-${lineAt(diff.deletionLines, content.deletionLineIndex + index)}` };
					oldLine += 1;
				}
				for (let index = 0; index < content.additions; index += 1) {
					yield { oldLine: null, newLine, text: `+${lineAt(diff.additionLines, content.additionLineIndex + index)}` };
					newLine += 1;
				}
			}
		}
	}
	if (!diff.isPartial) {
		while (newLine <= diff.additionLines.length) {
			yield { oldLine, newLine, text: ` ${lineAt(diff.additionLines, newLine - 1)}` };
			oldLine += 1;
			newLine += 1;
		}
	}
}

function rowMatches(row: DiffRow, line: number, side: SelectionSide): boolean {
	return (side === "deletions" ? row.oldLine : row.newLine) === line;
}

/** Resolve Pierre's directional, possibly cross-side selection against the displayed document. */
export function diffSelectionComment(diff: FileDiffMetadata, selection: SelectedLineRange) {
	// Pierre omits side for its default additions column, and endSide when both endpoints share it.
	const side = selection.side ?? "additions";
	const endSide = selection.endSide ?? side;
	const label = (line: number, column: SelectionSide) => `${column === "deletions" ? "old " : ""}L${line}`;
	const rangeLabel =
		side === endSide
			? `${label(Math.min(selection.start, selection.end), side)}${selection.start === selection.end ? "" : `-L${Math.max(selection.start, selection.end)}`}`
			: `${label(selection.start, side)} → ${label(selection.end, endSide)}`;
	const lines: string[] = [];
	let inside = false;
	let truncated = false;
	for (const row of diffRows(diff)) {
		const start = rowMatches(row, selection.start, side);
		const end = rowMatches(row, selection.end, endSide);
		const wasInside = inside;
		if (start || end) inside = true;
		if (inside) {
			if (lines.length < EXCERPT_MAX_LINES) lines.push(row.text.replace(/\r?\n$/, ""));
			else truncated = true;
			if ((wasInside && (start || end)) || (start && end)) break;
		}
	}
	return { rangeLabel, excerpt: [...lines, ...(truncated ? ["…"] : [])].join("\n") };
}
