import { errorMessage } from "@ling/contracts/ling-error";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useCopyFeedback } from "@renderer/hooks/use-copy-feedback";
import { Check, Copy, Download } from "lucide-react";
import { TableNode } from "markstream-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const FORMATS = ["Markdown", "Csv", "Tsv"] as const;
type TableFormat = (typeof FORMATS)[number];
/** Keep a clicked download URL alive for one second so the browser can acquire it. */
const DOWNLOAD_URL_LIFETIME_MS = 1_000;

function serializeTable(table: HTMLTableElement, format: TableFormat): string {
	const rows = Array.from(table.rows, (row) => Array.from(row.cells, (cell) => cell.innerText));
	if (format !== "Markdown") {
		const separator = format === "Csv" ? "," : "\t";
		return rows
			.map((row) =>
				row.map((cell) => (/["\n\r,\t]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(separator),
			)
			.join("\n");
	}
	const header = rows.shift();
	if (!header) throw new Error("The table has no header to copy.");
	const line = (cells: string[]) =>
		`| ${cells.map((cell) => cell.replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ")} |`;
	return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

/** Preserve table copy/export controls while Markstream owns parsing and column resizing. */
export function MarkdownTable(props: ComponentProps<typeof TableNode>) {
	const { t } = useTranslation();
	const ref = useRef<HTMLDivElement>(null);
	const downloads = useRef(new Map<string, number>());
	const mounted = useRef(false);
	const [failure, setFailure] = useState<string | null>(null);
	const { copiedKey, markCopied } = useCopyFeedback<TableFormat>();
	useEffect(() => {
		mounted.current = true;
		const pending = downloads.current;
		return () => {
			mounted.current = false;
			for (const [url, timer] of pending) {
				window.clearTimeout(timer);
				URL.revokeObjectURL(url);
			}
			pending.clear();
		};
	}, []);
	const act = async (format: TableFormat, download: boolean) => {
		setFailure(null);
		try {
			const table = ref.current?.querySelector("table");
			if (!table) throw new Error("The table is not available.");
			const text = serializeTable(table, format);
			if (!download) {
				if (!navigator.clipboard) throw new Error(t("markdown.clipboardUnavailable"));
				await navigator.clipboard.writeText(text);
				if (mounted.current) markCopied(format);
				return;
			}
			const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = `table.${format === "Markdown" ? "md" : format.toLowerCase()}`;
			link.click();
			downloads.current.set(
				url,
				window.setTimeout(() => {
					URL.revokeObjectURL(url);
					downloads.current.delete(url);
				}, DOWNLOAD_URL_LIFETIME_MS),
			);
		} catch (error) {
			if (mounted.current) setFailure(errorMessage(error));
		}
	};
	return (
		<div ref={ref} className="group/md-table min-w-0">
			<div className="flex justify-end gap-1 pb-1">
				{[false, true].map((download) => (
					<DropdownMenu key={download ? "download" : "copy"}>
						<DropdownMenuTrigger
							render={
								<button
									type="button"
									className="inline-flex size-7 items-center justify-center rounded-control text-text-muted hover:bg-surface-hover hover:text-text-primary"
									aria-label={t(
										download ? "markdown.downloadTable" : copiedKey ? "markdown.copied" : "markdown.copyTable",
									)}
								>
									{download ? (
										<Download className="size-3.5" />
									) : copiedKey ? (
										<Check className="size-3.5" />
									) : (
										<Copy className="size-3.5" />
									)}
								</button>
							}
						/>
						<DropdownMenuContent align="end">
							{FORMATS.map((format) => (
								<DropdownMenuItem
									key={format}
									onSelect={() => {
										void act(format, download);
									}}
								>
									{t(`markdown.tableFormat${format}`)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				))}
			</div>
			<TableNode {...props} />
			{failure && <FeedbackNotice tone="danger">{failure}</FeedbackNotice>}
		</div>
	);
}
