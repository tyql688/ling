interface ToolCallPart {
	name: string;
	arguments: Record<string, unknown>;
}

interface ToolCallSummary {
	/** One-line argument summary (command/path/pattern); null when there is nothing to show. */
	detail: string | null;
	/** True when detail is a filesystem path the caller may tildify for display. */
	isPath: boolean;
	/** Verbatim detail for the expanded card (the collapsed row hides its detail when open,
	 * so the card always restates it in full); null when there is nothing to show. */
	fullDetail: string | null;
}

/** Missing and empty-string arguments both mean "nothing to show". */
function stringArg(args: Record<string, unknown>, key: string): string | null {
	const value = args[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Collapse a multi-line command to one scannable line — the row clamps it with CSS truncate. */
function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Collapsed tool-step row content: the tool name (rendered by the caller) plus a one-line
 * detail ("bash df -h /"), never the raw multi-line arguments.
 */
export function toolCallSummary(part: ToolCallPart): ToolCallSummary {
	const args = part.arguments;
	switch (part.name) {
		case "bash": {
			const command = stringArg(args, "command");
			return {
				detail: command ? singleLine(command) : null,
				isPath: false,
				fullDetail: command,
			};
		}
		case "read":
		case "ls":
		case "write":
		case "edit":
		case "write_file":
		case "edit_file": {
			const path = stringArg(args, "path");
			return { detail: path, isPath: true, fullDetail: path };
		}
		case "grep":
		case "find": {
			const pattern = stringArg(args, "pattern");
			return { detail: pattern, isPath: false, fullDetail: pattern };
		}
		default:
			return { detail: null, isPath: false, fullDetail: null };
	}
}
