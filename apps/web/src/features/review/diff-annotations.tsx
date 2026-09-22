import type { ReviewCommentDraft, ReviewCommentIssue } from "@ling/contracts/draft-review-comments";
import type { DiffBasePropsReact, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs/react";
import { ReviewCommentEditor } from "@renderer/features/review/review-comment-editor";
import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { CODE_PREVIEW_DEFAULTS, CODE_THEME_PAIRS } from "@renderer/lib/preferences/code-preview";
import { useAtomValue } from "jotai";
import { type CSSProperties, type KeyboardEvent, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { diffSelectionComment } from "./diff-selection";

export interface DiffCommentContext {
	filePath: string;
	onAddComment: (comment: Omit<ReviewCommentDraft, "id">) => ReviewCommentIssue | null;
}

export const DIFF_STYLE = {
	"--diffs-bg": "transparent",
	"--diffs-light-bg": "transparent",
	"--diffs-dark-bg": "transparent",
	"--diffs-font-family": CODE_PREVIEW_DEFAULTS.fontFamily,
	"--diffs-font-size": `${CODE_PREVIEW_DEFAULTS.fontSizePx}px`,
	"--diffs-line-height": `${CODE_PREVIEW_DEFAULTS.fontSizePx + 8}px`,
	"--diffs-gap-block": "0px",
} as CSSProperties;

const DIFF_INTERACTION_CSS = `
	[data-code] { overflow: auto; }
	:focus, :focus-visible { outline: none; }

	[data-separator="line-info"]:is([data-expand-index], [data-ling-load-context]) [data-separator-wrapper] {
		cursor: pointer;
	}

	[data-separator="line-info"]:is([data-expand-index], [data-ling-load-context]) :is([data-expand-button], [data-separator-content]) {
		color: var(--diffs-fg);
		background-color: color-mix(in srgb, var(--diffs-fg) 5%, var(--diffs-bg-separator));
	}

	[data-separator="line-info"]:is([data-expand-index], [data-ling-load-context]) [data-separator-content] {
		gap: .5rem;
		font-weight: 600;
		text-decoration: none;
	}

	[data-separator="line-info"]:is([data-expand-index], [data-ling-load-context]) [data-separator-content]::before {
		content: "\\2195";
		color: var(--diffs-modified-base);
		font-size: 1rem;
		font-weight: 700;
	}

	[data-separator="line-info"]:is([data-expand-index], [data-ling-load-context]) :is([data-expand-button], [data-separator-content]):is(:hover, :focus-visible) {
		color: var(--diffs-fg);
		background-color: color-mix(in srgb, var(--diffs-fg) 12%, var(--diffs-bg-separator));
		text-decoration: none;
	}
`;

/** The rendered diff owns selection and an inline editor; accepted comments move into the session draft. */
export function useDiffAnnotations(
	diff: FileDiffMetadata,
	commentContext: DiffCommentContext | undefined,
	onLoadContext?: () => void,
) {
	const { t } = useTranslation();
	const appearance = useAtomValue(activeSkinAppearanceAtom);
	const [selected, setSelected] = useState<{ diff: FileDiffMetadata; range: SelectedLineRange } | null>(null);
	const [commenting, setCommenting] = useState(false);
	const selection = selected?.diff === diff ? selected.range : null;
	const onLineSelected = useCallback(
		(range: SelectedLineRange | null) => {
			setSelected(range === null ? null : { diff, range });
			setCommenting(range !== null);
		},
		[diff],
	);
	const comment = selection === null ? null : diffSelectionComment(diff, selection);
	const annotationProps: Pick<
		DiffBasePropsReact<undefined>,
		"selectedLines" | "lineAnnotations" | "renderAnnotation"
	> = {
		selectedLines: selection,
		lineAnnotations:
			selection === null || commentContext === undefined || !commenting
				? []
				: [{ side: selection.endSide ?? selection.side ?? "additions", lineNumber: selection.end }],
		renderAnnotation: () =>
			commentContext !== undefined && comment !== null ? (
				<div className="px-2 font-sans text-text-primary">
					<ReviewCommentEditor
						key={`${commentContext.filePath}:${comment.rangeLabel}`}
						rangeLabel={comment.rangeLabel}
						onCancel={() => setSelected(null)}
						onSubmit={(text) => {
							const issue = commentContext.onAddComment({ filePath: commentContext.filePath, ...comment, text });
							if (issue === null) setSelected(null);
							return issue;
						}}
					/>
				</div>
			) : null,
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget || commentContext === undefined) return;
		if (event.key === "Enter" && selection !== null) {
			event.preventDefault();
			setCommenting(true);
			return;
		}
		if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		// Alt chooses the original side; the ordinary keyboard path follows modified lines.
		const side = event.altKey ? "deletions" : "additions";
		const ranges = diff.hunks.flatMap((hunk) => {
			const start = side === "deletions" ? hunk.deletionStart : hunk.additionStart;
			const count = side === "deletions" ? hunk.deletionCount : hunk.additionCount;
			return count > 0 ? [{ start, end: start + count - 1 }] : [];
		});
		const first = ranges[0];
		const last = ranges.at(-1);
		if (first === undefined || last === undefined) return;
		const current = selection?.end;
		const next =
			event.key === "Home"
				? first.start
				: event.key === "End"
					? last.end
					: current === undefined
						? first.start
						: current + (event.key === "ArrowUp" ? -1 : 1);
		const targetRange =
			event.key === "ArrowUp"
				? ranges.findLast((range) => range.start <= next)
				: ranges.find((range) => range.end >= next);
		const line =
			targetRange === undefined
				? Math.max(first.start, Math.min(last.end, next))
				: Math.max(targetRange.start, Math.min(targetRange.end, next));
		setCommenting(false);
		setSelected({
			diff,
			range: { start: event.shiftKey && selection?.side === side ? selection.start : line, end: line, side },
		});
	};
	const localizeControls = useCallback(
		(node: HTMLElement) => {
			// Pierre 1.3/1.4 have no locale option. Its post-render hook and data markers let
			// Ling translate labels without taking over hunk layout, expansion or coordinates.
			for (const label of node.shadowRoot?.querySelectorAll<HTMLElement>("[data-unmodified-lines]") ?? []) {
				const count = label.textContent.match(/\d+/)?.[0];
				// Cosmetic label adaptation must not discard a readable diff when upstream markup changes.
				if (count === undefined) continue;
				const separator = label.closest<HTMLElement>("[data-separator]");
				const nativeExpansion = separator?.hasAttribute("data-expand-index") === true;
				const expandable = nativeExpansion || onLoadContext !== undefined;
				separator?.toggleAttribute("data-ling-load-context", !nativeExpansion && onLoadContext !== undefined);
				const localized = t(expandable ? "changes.diffExpandUnmodifiedLines" : "changes.diffUnmodifiedLines", {
					count: Number(count),
				});
				label.textContent = localized;
				const content = label.parentElement;
				if (content === null) continue;
				content.onclick = null;
				content.onkeydown = null;
				content.removeAttribute("aria-label");
				content.removeAttribute("role");
				content.removeAttribute("tabindex");
				if (expandable) {
					content.setAttribute("aria-label", localized);
					content.setAttribute("role", "button");
					content.tabIndex = 0;
					const expand = () => {
						if (nativeExpansion) label.click();
						else onLoadContext?.();
					};
					content.onclick = (event) => {
						if (!nativeExpansion || event.target === content) expand();
					};
					content.onkeydown = (event) => {
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						event.stopPropagation();
						expand();
					};
				}
			}
			for (const marker of node.shadowRoot?.querySelectorAll<HTMLElement>("[data-no-newline] > span") ?? []) {
				marker.textContent = t("changes.diffNoNewline");
			}
			for (const button of node.shadowRoot?.querySelectorAll<HTMLElement>("[data-expand-button]") ?? []) {
				const all = button.hasAttribute("data-expand-all-button");
				const label = t(all ? "changes.diffExpandAll" : "changes.diffExpandContext");
				if (all) button.textContent = label;
				button.setAttribute("aria-label", label);
				button.tabIndex = 0;
				button.onkeydown = (event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					event.stopPropagation();
					button.click();
				};
			}
		},
		[onLoadContext, t],
	);
	const options = useMemo(
		() => ({
			theme: CODE_THEME_PAIRS[appearance.codeTheme],
			themeType: appearance.appearance,
			disableFileHeader: true,
			enableLineSelection: commentContext !== undefined,
			onLineSelected,
			onPostRender: localizeControls,
			hunkSeparators: "line-info" as const,
			// The viewport owns scrollbars; unchanged context expands in bounded batches.
			unsafeCSS: DIFF_INTERACTION_CSS,
			expansionLineCount: 20,
			collapsedContextThreshold: 3,
		}),
		[appearance.appearance, appearance.codeTheme, commentContext, localizeControls, onLineSelected],
	);
	return {
		annotationProps,
		options,
		keyboardProps:
			commentContext === undefined
				? {}
				: { role: "group", tabIndex: 0, "aria-label": t("changes.commentKeyboard"), onKeyDown },
	};
}
