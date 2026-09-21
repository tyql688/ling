import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { ConversationBackdrop } from "@renderer/lib/appearance/skins/skin-backdrop";
import {
	readJsonPreference,
	RENDERER_PREFERENCE_KEYS,
	writeRendererPreference,
} from "@renderer/lib/preferences/renderer-preferences";
import { cn } from "@renderer/lib/utils";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type PointerEvent,
	type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { WorkbenchLayoutContext } from "./workbench-layout-context";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";

interface WorkbenchGeometry {
	version: 1;
	conversation: number;
	sidebar: number;
}
// These are preferred pixel sizes. Viewport constraints never overwrite the stored preference.
const DEFAULT_GEOMETRY: WorkbenchGeometry = { version: 1, conversation: 400, sidebar: 280 };
const MAX_CONVERSATION_WIDTH = 1600;
function readGeometry(): WorkbenchGeometry {
	return readJsonPreference(RENDERER_PREFERENCE_KEYS.workbenchGeometry, DEFAULT_GEOMETRY, (value) => {
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== 1 ||
			!("conversation" in value) ||
			!("sidebar" in value)
		)
			return null;
		return typeof value.conversation === "number" &&
			Number.isFinite(value.conversation) &&
			value.conversation >= 300 &&
			value.conversation <= MAX_CONVERSATION_WIDTH &&
			typeof value.sidebar === "number" &&
			Number.isFinite(value.sidebar) &&
			value.sidebar >= 240 &&
			value.sidebar <= 600
			? (value as WorkbenchGeometry)
			: null;
	}).value;
}

interface WorkbenchSlotHostProps {
	/** The window's single top-level chrome row: conversation tabs and window-level controls. */
	chrome: ReactNode;
	/** The reading column's own tab strip, nested one level under the chrome row. */
	readingHeader?: ReactNode;
	top: ReactNode;
	main: ReactNode;
	reading?: ReactNode;
	bottom: (content: ReactNode) => ReactNode;
	side: ReactNode;
	overlay: ReactNode;
	expanded?: boolean;
	terminalHeight?: number;
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
	bottom,
	side,
	overlay,
	expanded = false,
	terminalHeight = 0,
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
	const [compactSideOpen, setCompactSideOpen] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [composerHeight, setComposerHeight] = useState(0);
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
	// Below 760px, two usable content columns no longer fit. This is an effective layout,
	// not a mutation of the user's saved reading expansion or preferred column widths.
	const compact = size.width > 0 && size.width < 760;
	const floating = hasReading && (expanded || compact);
	const sidebarWidth = Math.min(geometry.sidebar, Math.max(240, size.width - 80));
	const conversationWidth = Math.min(geometry.conversation, Math.max(300, size.width - 620));
	const readingWidth = hasReading ? size.width - (floating ? 0 : conversationWidth) : sidebarWidth;
	const dockSide = hasReading ? !compact && readingWidth >= 620 : size.width >= 680;
	const sideOpen = rightOpen && side !== null;
	const dockedSideWidth =
		sideOpen && dockSide ? Math.min(sidebarWidth, hasReading ? readingWidth - 340 : sidebarWidth) : 0;
	const hasRightColumn = hasReading || (sideOpen && dockSide);
	const floatingWidth = Math.min(760, Math.max(0, size.width - dockedSideWidth - 40));

	const sideVisible = rightOpen;
	const focusSideTrigger = useCallback(() => {
		const trigger = [...(shellRef.current?.querySelectorAll<HTMLElement>("[data-workspace-side-trigger]") ?? [])].find(
			(node) => node.offsetParent !== null,
		);
		trigger?.focus({ preventScroll: true });
	}, []);
	const previousSideOpen = useRef(rightOpen);
	useLayoutEffect(() => {
		if (dockSide || !rightOpen) setCompactSideOpen(false);
		else if (!previousSideOpen.current) setCompactSideOpen(true);
		if (
			!rightOpen &&
			previousSideOpen.current &&
			document.activeElement?.closest("[data-workspace-reading], [data-workspace-context-sidebar]")
		)
			focusSideTrigger();
		previousSideOpen.current = rightOpen;
	}, [rightOpen, dockSide, focusSideTrigger]);
	const toggleSidePanel = useCallback(() => {
		if (rightOpen) onSideClose();
		else {
			if (!dockSide) setCompactSideOpen(true);
			onSideToggle();
		}
	}, [onSideClose, onSideToggle, rightOpen, dockSide]);
	const layout = useMemo(
		() => ({ floating, compact, hasReading, hasRightColumn, sideVisible, toggleSidePanel, setComposerHeight }),
		[floating, compact, hasReading, hasRightColumn, sideVisible, toggleSidePanel],
	);

	const transition = { duration: reducedMotion || dragging ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] as const };
	const commit = (field: "conversation" | "sidebar", value: number) => {
		const next = { ...geometry, [field]: Math.round(value) };
		setGeometry(next);
		try {
			writeRendererPreference(RENDERER_PREFERENCE_KEYS.workbenchGeometry, JSON.stringify(next));
		} catch (error) {
			onError(error);
		}
	};
	return (
		<WorkbenchLayoutContext.Provider value={layout}>
			{shortcuts}
			<div ref={shellRef} className="conversation-scene relative flex min-h-0 min-w-0 flex-1 flex-col">
				<ConversationBackdrop />
				<div className="shrink-0">{chrome}</div>
				<div
					ref={rootRef}
					data-workbench-slot-host=""
					data-reading-expanded={floating || undefined}
					className="relative grid min-h-0 min-w-0 flex-1 overflow-hidden"
					style={{
						gridTemplateColumns:
							!hasRightColumn || floating
								? "minmax(0, 1fr)"
								: hasReading
									? `${conversationWidth}px minmax(0, 1fr)`
									: `minmax(0, 1fr) ${dockedSideWidth}px`,
					}}
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
							floating ? "pointer-events-none absolute z-30" : "relative col-start-1 overflow-hidden",
						)}
						style={
							floating
								? {
										width: floatingWidth || "calc(100% - 40px)",
										left: Math.max(20, (size.width - dockedSideWidth - floatingWidth) / 2),
										bottom: 16,
										height: Math.max(160, Math.min(620, size.height - 76)),
									}
								: {}
						}
					>
						{bottom(
							<div className={cn("flex min-h-0 flex-1 flex-col", floating && "workbench-floating-conversation")}>
								{top}
								{main}
							</div>,
						)}
					</motion.section>
					{hasReading && !floating && (
						<WorkbenchDivider
							label={t("reading.resizeConversation")}
							value={conversationWidth}
							min={300}
							max={Math.min(MAX_CONVERSATION_WIDTH, Math.max(300, size.width - 620))}
							onChange={(value) => setGeometry((current) => ({ ...current, conversation: value }))}
							onCommit={(value) => commit("conversation", value)}
							onDragging={setDragging}
							onReset={() => commit("conversation", DEFAULT_GEOMETRY.conversation)}
							style={{ left: conversationWidth }}
						/>
					)}
					<section
						data-workspace-reading=""
						aria-label={t("reading.region")}
						onFocusCapture={onReadingFocus}
						onPointerDownCapture={onReadingFocus}
						inert={!hasRightColumn ? true : undefined}
						className={cn(
							"skin-surface flex min-h-0 min-w-0 flex-col overflow-hidden bg-workbench-surface",
							!hasRightColumn && "hidden",
							hasRightColumn && !floating && "workbench-reading-seam",
						)}
						style={{ gridColumn: floating || !hasRightColumn ? 1 : 2, gridRow: 1 }}
					>
						{readingHeader}
						<div className="relative flex min-h-0 min-w-0 flex-1">
							<div
								className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !hasReading && "hidden")}
								style={{ marginRight: dockedSideWidth }}
							>
								<div
									className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface"
									style={{ paddingBottom: floating ? composerHeight + terminalHeight + 52 : 0 }}
								>
									{reading}
								</div>
							</div>
							{dockedSideWidth > 0 && hasReading && (
								<WorkbenchDivider
									label={t("nav.resizeSidePanel")}
									value={dockedSideWidth}
									min={240}
									max={Math.min(600, readingWidth - 340)}
									direction={-1}
									onChange={(value) => setGeometry((current) => ({ ...current, sidebar: value }))}
									onCommit={(value) => commit("sidebar", value)}
									onDragging={setDragging}
									onReset={() => commit("sidebar", DEFAULT_GEOMETRY.sidebar)}
									style={{ right: dockedSideWidth }}
								/>
							)}
							<AnimatePresence initial={false}>
								{sideOpen && dockSide && (
									<SidebarPresence
										key="sidebar"
										initial={{ x: 24, opacity: 0 }}
										animate={{ x: 0, opacity: 1 }}
										exit={{ x: 24, opacity: 0 }}
										transition={transition}
										className="absolute inset-y-0 right-0 flex min-h-0 border-l border-border-subtle"
										style={{ width: dockedSideWidth }}
										data-workspace-context-sidebar=""
									>
										{side}
									</SidebarPresence>
								)}
							</AnimatePresence>
						</div>
					</section>
					{sideOpen && !dockSide && compactSideOpen && (
						<Dialog
							open
							onOpenChange={(open) => {
								if (!open) onSideClose();
							}}
						>
							<DialogContent
								variant="workspace-right-sheet"
								portalled={false}
								overlayClassName="absolute"
								className="flex flex-col overflow-hidden p-0"
								onCloseAutoFocus={(event) => {
									event.preventDefault();
									focusSideTrigger();
								}}
							>
								<DialogTitle className="sr-only">{t("nav.sidePanel")}</DialogTitle>
								{side}
							</DialogContent>
						</Dialog>
					)}
					{overlay}
				</div>
			</div>
		</WorkbenchLayoutContext.Provider>
	);
}

function WorkbenchDivider({
	label,
	value,
	min,
	max,
	direction = 1,
	onChange,
	onCommit,
	onDragging,
	onReset,
	style,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	direction?: number;
	onChange(value: number): void;
	onCommit(value: number): void;
	onDragging(value: boolean): void;
	onReset(): void;
	style: React.CSSProperties;
}) {
	const drag = useRef<{ start: number; value: number; next: number } | null>(null);
	const bound = (size: number) => Math.max(min, Math.min(max, size));
	const end = (event: PointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		const next = drag.current.next;
		drag.current = null;
		onDragging(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		onCommit(next);
	};
	const keys = (event: KeyboardEvent<HTMLDivElement>) => {
		const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
		if (!delta && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		onCommit(
			event.key === "Home"
				? min
				: event.key === "End"
					? max
					: bound(value + delta * direction * (event.shiftKey ? 40 : 10)),
		);
	};
	/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable ARIA window splitter supports pointer, arrow, Home and End resizing. */
	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation="vertical"
			aria-valuenow={Math.round(value)}
			aria-valuemin={min}
			aria-valuemax={Math.round(max)}
			tabIndex={0}
			className="workbench-column-divider absolute inset-y-0 z-40 w-px cursor-col-resize outline-none"
			style={style}
			onKeyDown={keys}
			onDoubleClick={onReset}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				drag.current = { start: event.clientX, value, next: value };
				event.currentTarget.setPointerCapture(event.pointerId);
				onDragging(true);
			}}
			onPointerMove={(event) => {
				if (!drag.current) return;
				const next = bound(drag.current.value + (event.clientX - drag.current.start) * direction);
				drag.current.next = next;
				onChange(next);
			}}
			onPointerUp={end}
			onPointerCancel={end}
			onLostPointerCapture={end}
		/>
	);
}
/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */

/** Exit paint must not retain interactive descendants after the sidebar closes. */
function SidebarPresence(props: React.ComponentProps<typeof motion.div>) {
	const present = useIsPresent();
	return <motion.div {...props} inert={!present} aria-hidden={!present} />;
}
