import { WorkbenchDivider } from "./workbench-divider";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { ArrowLeftRight } from "lucide-react";
import { ConversationBackdrop } from "@renderer/lib/appearance/skins/skin-backdrop";
import { dragRegionClassName } from "@renderer/lib/platform";
import {
	readJsonPreference,
	RENDERER_PREFERENCE_KEYS,
	writeRendererPreference,
} from "@renderer/lib/preferences/renderer-preferences";
import { cn } from "@renderer/lib/utils";
import { motion } from "motion/react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { WorkbenchLayoutContext } from "./workbench-layout-context";
import {
	DEFAULT_GEOMETRY,
	MIN_CONVERSATION_WIDTH,
	parseWorkbenchGeometry,
	rightColumnWidth,
	type WorkbenchGeometry,
	withRightWidth,
} from "./workbench-geometry";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";

function readGeometry(): WorkbenchGeometry {
	return readJsonPreference(RENDERER_PREFERENCE_KEYS.workbenchGeometry, DEFAULT_GEOMETRY, parseWorkbenchGeometry).value;
}

interface WorkbenchSlotHostProps {
	/** Current conversation title and controls. */
	chrome: ReactNode;
	/** Reading tabs align with the conversation title when both columns fit. */
	readingHeader?: ReactNode;
	top: ReactNode;
	main: ReactNode;
	reading?: ReactNode;
	overlay: ReactNode;
	expanded?: boolean;
	rightOpen: boolean;
	onSideClose(): void;
	onSideToggle(): void;
	shortcuts: ReactNode;
	onConversationFocus?(): void;
	onReadingFocus?(): void;
}

/** Four regions share geometry without reparenting the transcript or its editor. */
export function WorkbenchSlotHost({
	chrome,
	readingHeader,
	top,
	main,
	reading = null,
	overlay,
	expanded = false,
	rightOpen,
	onSideClose,
	onSideToggle,
	shortcuts,
	onConversationFocus,
	onReadingFocus,
}: WorkbenchSlotHostProps) {
	const { t } = useTranslation();
	const onError = useCommandFeedback();
	const shellRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [geometry, setGeometry] = useState(readGeometry);
	const reducedMotion = useReducedMotion();
	const [dragging, setDragging] = useState(false);
	const [composerHeight, setComposerHeight] = useState(0);
	const [dockedSideWidth, setDockedNavigationWidth] = useState(0);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const measure = () => {
			const box = root.getBoundingClientRect();
			setSize((current) =>
				current.width === box.width && current.height === box.height
					? current
					: { width: box.width, height: box.height },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);
	const hasReading = rightOpen && reading !== null;
	// Below 760px, adapt the layout to one usable content column while retaining the saved expansion and width preferences.

	const compact = size.width > 0 && size.width < 760;
	const floating = hasReading && (expanded || compact);
	const conversationWidth = size.width - rightColumnWidth(geometry, size.width, size.height);
	const hasRightColumn = hasReading;
	const floatingWidth = Math.min(760, Math.max(0, size.width - dockedSideWidth - 40));
	// Only a narrow window moves the tabs below the titlebar.
	const splitChrome = hasReading && !compact;
	const expandedChrome = splitChrome && floating;
	const readingOnLeft = geometry.readingOnLeft && splitChrome;
	const conversationColumn = readingOnLeft ? 2 : 1;
	const readingColumn = readingOnLeft ? 1 : 2;
	const dividerLeft = readingOnLeft ? size.width - conversationWidth : conversationWidth;
	const chromeColumns = !splitChrome
		? "minmax(0, 1fr)"
		: expandedChrome
			? readingOnLeft
				? "minmax(0, 1fr) max-content"
				: "max-content minmax(0, 1fr)"
			: readingOnLeft
				? `minmax(0, 1fr) ${conversationWidth}px`
				: `${conversationWidth}px minmax(0, 1fr)`;
	const columns =
		!hasRightColumn || floating
			? "minmax(0, 1fr)"
			: readingOnLeft
				? `minmax(0, 1fr) ${conversationWidth}px`
				: `${conversationWidth}px minmax(0, 1fr)`;

	const sideVisible = rightOpen;
	const focusSideTrigger = useCallback(() => {
		const trigger = [...(shellRef.current?.querySelectorAll<HTMLElement>("[data-workspace-side-trigger]") ?? [])].find(
			(node) => node.offsetParent !== null,
		);
		trigger?.focus({ preventScroll: true });
	}, []);
	const previousSideOpen = useRef(rightOpen);
	useLayoutEffect(() => {
		// Move focus to visible content when the right column closes.
		if (
			!rightOpen &&
			previousSideOpen.current &&
			document.activeElement?.closest("[data-workspace-reading], [data-workspace-context-sidebar]")
		)
			focusSideTrigger();
		previousSideOpen.current = rightOpen;
	}, [rightOpen, focusSideTrigger]);
	const toggleSidePanel = useCallback(() => {
		if (rightOpen) onSideClose();
		else onSideToggle();
	}, [onSideClose, onSideToggle, rightOpen]);
	const transition = { duration: reducedMotion || dragging ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] as const };
	const commit = useCallback(
		(next: WorkbenchGeometry) => {
			setGeometry(next);
			try {
				writeRendererPreference(RENDERER_PREFERENCE_KEYS.workbenchGeometry, JSON.stringify(next));
			} catch (error) {
				onError(error);
			}
		},
		[onError],
	);
	const resizeNavigation = useCallback(
		(width: number, persist: boolean) => {
			const next = { ...geometry, sidebar: Math.round(width) };
			if (persist) commit(next);
			else setGeometry(next);
		},
		[commit, geometry],
	);
	const layout = useMemo(
		() => ({
			floating,
			compact,
			hasReading,
			hasRightColumn,
			sideVisible,
			readingOnLeft,
			navigationWidth: geometry.sidebar,
			resizeNavigation,
			setDockedNavigationWidth,
			contentBottomInset: floating ? composerHeight + 52 : 0,
			toggleSidePanel,
			setComposerHeight,
		}),
		[
			floating,
			compact,
			hasReading,
			hasRightColumn,
			sideVisible,
			readingOnLeft,
			geometry.sidebar,
			resizeNavigation,
			composerHeight,
			toggleSidePanel,
		],
	);

	return (
		<WorkbenchLayoutContext.Provider value={layout}>
			{shortcuts}
			<div
				ref={shellRef}
				data-reading-on-left={readingOnLeft || undefined}
				className="conversation-scene relative flex min-h-0 min-w-0 flex-1 flex-col"
			>
				<ConversationBackdrop />
				<div
					className={cn(
						"relative z-30 grid shrink-0",
						dragRegionClassName,
						expandedChrome && "skin-surface bg-workbench-surface",
					)}
					style={{ gridTemplateColumns: chromeColumns }}
				>
					<div
						className="min-w-0"
						style={{ gridColumn: conversationColumn, gridRow: 1 }}
						onFocusCapture={onConversationFocus}
						onPointerDownCapture={onConversationFocus}
					>
						{chrome}
					</div>
					{splitChrome && (
						<div
							className={cn("min-w-0", !expandedChrome && "skin-surface workbench-reading-seam bg-workbench-surface")}
							style={{ gridColumn: readingColumn, gridRow: 1 }}
							onFocusCapture={onReadingFocus}
							onPointerDownCapture={onReadingFocus}
						>
							{readingHeader}
						</div>
					)}
				</div>
				<div
					ref={rootRef}
					data-workbench-slot-host=""
					data-reading-expanded={floating || undefined}
					className="relative grid min-h-0 min-w-0 flex-1 overflow-hidden"
					style={{ gridTemplateColumns: columns }}
				>
					<motion.section
						data-workspace-conversation=""
						aria-label={t("session.conversationLog")}
						layout="position"
						transition={transition}
						onFocusCapture={onConversationFocus}
						onPointerDownCapture={onConversationFocus}
						className={cn(
							"flex min-h-0 min-w-0 flex-col",
							floating ? "pointer-events-none absolute z-30" : "relative overflow-hidden",
						)}
						style={
							floating
								? {
										width: floatingWidth || "calc(100% - 40px)",
										left: Math.max(20, (size.width - dockedSideWidth - floatingWidth) / 2),
										bottom: 16,
										height: Math.max(160, Math.min(620, size.height - 76)),
									}
								: { gridColumn: conversationColumn, gridRow: 1 }
						}
					>
						<div className={cn("flex min-h-0 flex-1 flex-col", floating && "workbench-floating-conversation")}>
							{top}
							{main}
						</div>
					</motion.section>
					{hasReading && !floating && (
						<>
							<WorkbenchDivider
								label={t("reading.resizeConversation")}
								direction={readingOnLeft ? -1 : 1}
								value={conversationWidth}
								min={MIN_CONVERSATION_WIDTH}
								max={Math.max(MIN_CONVERSATION_WIDTH, size.width - 320)}
								onChange={(value) => setGeometry((current) => withRightWidth(current, size.width - value, size.width))}
								onCommit={(value) => commit(withRightWidth(geometry, size.width - value, size.width))}
								onDragging={setDragging}
								onReset={() => commit({ ...geometry, rightRatio: null, legacyConversation: null })}
								style={{ left: dividerLeft }}
							/>
							<TooltipIconButton
								label={t("reading.swapPanes")}
								onClick={() => commit({ ...geometry, readingOnLeft: !geometry.readingOnLeft })}
								className="absolute top-1/2 z-40 -translate-x-1/2 -translate-y-1/2 border border-border-subtle bg-surface-raised shadow-(--shadow-control)"
								style={{ left: dividerLeft }}
							>
								<ArrowLeftRight className="size-3.5" aria-hidden="true" />
							</TooltipIconButton>
						</>
					)}
					<section
						data-workspace-reading=""
						aria-label={t("reading.region")}
						onFocusCapture={onReadingFocus}
						onPointerDownCapture={onReadingFocus}
						inert={!hasRightColumn ? true : undefined}
						// The header, content and docked tree each paint one material layer. A transparent column container keeps translucent skins from stacking alpha.

						className={cn(
							"skin-surface flex min-h-0 min-w-0 flex-col overflow-hidden",
							!floating && "workbench-reading-seam",
							!hasRightColumn && "hidden",
						)}
						style={{ gridColumn: floating || !hasRightColumn ? 1 : readingColumn, gridRow: 1 }}
					>
						{!splitChrome && hasReading && <div className="shrink-0 bg-workbench-surface">{readingHeader}</div>}
						{reading}
					</section>
					{overlay}
				</div>
			</div>
		</WorkbenchLayoutContext.Provider>
	);
}
