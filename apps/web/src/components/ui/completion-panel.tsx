import { autoUpdate, offset, size, useFloating } from "@floating-ui/react-dom";
import { MaterialFileIcon } from "@renderer/components/material-code-icon";
import { cn } from "@renderer/lib/utils";
import { BookOpen, CornerDownLeft, FileText, Folder, Puzzle, Search, Terminal, TextCursorInput } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { menuContentClass, menuItemClass } from "./menu-styles";
import { Button } from "./button";

export interface CompletionItem {
	name: string;
	displayText?: string;
	description: string;
	kind?: "command" | "extension" | "skill" | "prompt" | "file" | "directory" | "argument" | "suggestion";
	iconPath?: string;
	argumentHint?: string | undefined;
	/** Selection executes a command immediately instead of inserting text. */
	immediate?: boolean;
}

export interface CompletionPanelProps {
	id: string;
	open: boolean;
	items: readonly CompletionItem[];
	activeIndex: number;
	onActiveChange: (index: number) => void;
	onSelect: (index: number) => void;
	mode: "command" | "skill" | "file" | "suggestion";
	loading?: boolean;
	error?: string | null;
	onRetry?: () => void;
}

function group(item: CompletionItem): string {
	return item.kind === "directory" ? "file" : (item.kind ?? "suggestion");
}

function CompletionIcon({ item }: { item: CompletionItem }) {
	if (item.kind === "file") return <MaterialFileIcon path={item.iconPath ?? item.name} className="size-4" />;
	const Icon =
		item.kind === "directory"
			? Folder
			: item.kind === "skill"
				? BookOpen
				: item.kind === "extension"
					? Puzzle
					: item.kind === "prompt"
						? FileText
						: item.kind === "command"
							? Terminal
							: TextCursorInput;
	return <Icon className="size-4" aria-hidden="true" />;
}

/** Shared listbox geometry and presentation; the input retains focus and owns completion semantics. */
export function CompletionPanel({
	id,
	open,
	items,
	activeIndex,
	onActiveChange,
	onSelect,
	mode,
	loading = false,
	error = null,
	onRetry,
}: CompletionPanelProps) {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement>(null);
	const active = items[activeIndex];
	const { refs, floatingStyles, isPositioned } = useFloating({
		open,
		placement: "top-start",
		whileElementsMounted: autoUpdate,
		middleware: [
			offset(8),
			size({
				apply({ availableHeight, rects, elements }) {
					Object.assign(elements.floating.style, {
						width: `${rects.reference.width}px`,
						// Leave room for the surrounding conversation, including at browser/native zoom.
						maxHeight: `min(26rem, ${Math.max(0, availableHeight - 8)}px)`,
					});
				},
			}),
		],
	});
	useLayoutEffect(() => {
		refs.setReference(open ? (refs.floating.current?.parentElement ?? null) : null);
	}, [open, refs]);
	useEffect(() => {
		listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, active?.name, open]);
	if (!open) return null;
	const action = active?.immediate ? "run" : mode === "file" ? "attach" : "insert";
	return (
		<div
			ref={refs.setFloating}
			style={{ ...floatingStyles, visibility: isPositioned ? "visible" : "hidden" }}
			data-completion-panel=""
			className={cn(menuContentClass, "flex min-h-0 flex-col overflow-hidden rounded-panel")}
		>
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs text-text-muted">
				<Search className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 flex-1">{t(`completion.title.${mode}`)}</span>
				<span className="tabular-nums" aria-hidden="true">
					{items.length > 0 ? items.length : null}
				</span>
			</div>
			<div
				ref={listRef}
				id={id}
				role="listbox"
				aria-label={t(`completion.title.${mode}`)}
				aria-busy={loading}
				className="min-h-0 overflow-y-auto overscroll-contain p-1.5"
			>
				{items.map((item, index) => {
					const category = group(item);
					const previous = items[index - 1];
					return (
						<Fragment key={`${category}:${item.name}`}>
							{(!previous || group(previous) !== category) && (
								<div role="presentation" className="px-2.5 pb-1 pt-2 text-xs font-medium text-text-muted">
									{t(`completion.group.${category}`)}
								</div>
							)}
							<button
								id={`${id}-${index}`}
								type="button"
								role="option"
								tabIndex={-1}
								aria-selected={index === activeIndex}
								aria-label={`${item.displayText ?? `/${item.name}`} ${item.argumentHint ?? ""}`.trim()}
								aria-describedby={item.description ? `${id}-${index}-description` : undefined}
								onMouseDown={(event) => event.preventDefault()}
								onPointerMove={() => onActiveChange(index)}
								onClick={() => onSelect(index)}
								className={cn(
									menuItemClass,
									"w-full items-start gap-3 px-2.5 py-2 text-start",
									index === activeIndex && "bg-surface-hover",
								)}
							>
								<span className="mt-0.5 shrink-0 text-text-muted">
									<CompletionIcon item={item} />
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
										<span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
											{item.displayText ?? `/${item.name}`}
										</span>
										{item.argumentHint && <span className="text-xs text-text-muted">{item.argumentHint}</span>}
									</span>
									{item.description && (
										<span
											id={`${id}-${index}-description`}
											className="mt-0.5 block text-ui text-text-muted [overflow-wrap:anywhere]"
										>
											{item.description}
										</span>
									)}
								</span>
								{index === activeIndex && <CornerDownLeft className="mt-0.5 text-text-muted" aria-hidden="true" />}
							</button>
						</Fragment>
					);
				})}
			</div>
			{(error || items.length === 0) && (
				<div role="status" className="px-4 py-4 text-sm leading-6 text-text-muted [overflow-wrap:anywhere]">
					{error ?? t(loading ? "completion.loading" : "completion.empty")}
					{error && onRetry && (
						<Button
							size="sm"
							variant="outline"
							tabIndex={-1}
							className="mt-2 flex"
							onMouseDown={(event) => event.preventDefault()}
							onClick={onRetry}
						>
							{t("common.retry")}
						</Button>
					)}
				</div>
			)}
			<div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle px-3 py-2 text-xs text-text-muted">
				{error && onRetry && (
					<span>
						<kbd>Enter</kbd> {t("common.retry")}
					</span>
				)}
				{active && (
					<>
						<span>
							<kbd>↑ ↓</kbd> {t("completion.navigate")}
						</span>
						<span>
							<kbd>Enter / Tab</kbd> {t(`completion.${action}`)}
						</span>
					</>
				)}
				<span className="ms-auto">
					<kbd>Esc</kbd> {t("completion.close")}
				</span>
			</div>
		</div>
	);
}
