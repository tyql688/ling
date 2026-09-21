import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ExtensionUiStateSnapshot, SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import { SessionProgressIndicator } from "@renderer/features/chat/transcript/session-progress-indicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import Ansi from "ansi-to-react";
import { X } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	EMPTY_CUSTOM_PANEL_FOCUS_STATE,
	isPassiveCustomPanel,
	synchronizeCustomPanelFocus,
} from "./extension-custom-panel-focus";
import { extensionKeyData } from "./extension-terminal-keys";
import { projectExtensionTerminalText } from "./extension-terminal-text";
import { measureExtensionViewport } from "./extension-ui-viewport";

/** Browser projections of Pi's interactive chrome. Headers belong to the transcript;
 * custom panels retain their overlay geometry and input semantics. Persistent status,
 * widgets, footer, and notification history live in the extension dock. */
type ExtensionCustomPanelState = NonNullable<ExtensionUiStateSnapshot["customPanel"]>;

export function ExtensionLinesBlock({ lines, className }: { lines: string[]; className: string }) {
	if (lines.length === 0) return null;
	return (
		<div className={className}>
			{lines.map((line, index) => (
				// eslint-disable-next-line react/no-array-index-key -- Extension UI lines are an immutable text snapshot.
				<p key={index} className="min-w-max whitespace-pre">
					<Ansi useClasses>{projectExtensionTerminalText(line)}</Ansi>
				</p>
			))}
		</div>
	);
}

export function ExtensionTranscriptHeader({ lines }: { lines: string[] | null }) {
	if (lines === null) return null;
	return (
		<ExtensionLinesBlock lines={lines} className="mb-5 min-w-0 font-mono text-xs leading-relaxed text-text-muted" />
	);
}

/** Uses extension frames when provided, otherwise a CSS animation that survives parent renders. */
export function ExtensionWorkingIndicator({ indicator }: { indicator: ExtensionUiStateSnapshot["workingIndicator"] }) {
	const frames = indicator?.frames ?? null;
	const intervalMs = indicator?.intervalMs ?? 120;
	const framesKey = frames === null ? "" : frames.join("\0");
	const [frameIndex, setFrameIndex] = useState(0);

	useEffect(() => {
		setFrameIndex(0);
		if (framesKey === "") return;
		const frameCount = framesKey.split("\0").length;
		if (frameCount <= 1) return;
		const timer = window.setInterval(() => setFrameIndex((current) => (current + 1) % frameCount), intervalMs);
		return () => window.clearInterval(timer);
	}, [framesKey, intervalMs]);

	// Default / no frames: use the stable pure-CSS working animation.
	if (indicator === null || frames === null || frames.length === 0) {
		return <SessionProgressIndicator />;
	}
	return (
		<span className="inline-flex w-4 shrink-0 justify-center text-accent" aria-hidden="true">
			<Ansi useClasses>{projectExtensionTerminalText(frames[frameIndex % frames.length] ?? "")}</Ansi>
		</span>
	);
}

function overlayColumnSize(value: ExtensionCustomPanelState["layout"]["width"]): string | undefined {
	if (value === null) return undefined;
	return typeof value === "number" ? `${value}ch` : value;
}

function overlayRowSize(value: ExtensionCustomPanelState["layout"]["maxHeight"]): string | undefined {
	if (value === null) return undefined;
	return typeof value === "number" ? `${value}lh` : value;
}

function customPanelShellStyle(layout: ExtensionCustomPanelState["layout"]): CSSProperties {
	const margin = layout.margin;
	if (margin === null) return { padding: "1rem" };
	return {
		paddingTop: `${margin.top}lh`,
		paddingRight: `${margin.right}ch`,
		paddingBottom: `${margin.bottom}lh`,
		paddingLeft: `${margin.left}ch`,
	};
}

type OverlayPositionValue = NonNullable<ExtensionCustomPanelState["layout"]["row"]>;

function overlayPositionValue(value: OverlayPositionValue, unit: "ch" | "lh"): string {
	return typeof value === "number" ? `${value}${unit}` : value;
}

function overlayPercent(value: OverlayPositionValue): number | null {
	if (typeof value !== "string") return null;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	const percent = match?.[1];
	return percent === undefined ? null : Number.parseFloat(percent);
}

function customPanelStyle(layout: ExtensionCustomPanelState["layout"]): CSSProperties {
	const style: CSSProperties = {
		position: "absolute",
		width: overlayColumnSize(layout.width) ?? "min(48rem, calc(100vw - 2rem))",
		minWidth: layout.minWidth === null ? undefined : `${layout.minWidth}ch`,
		maxWidth: layout.margin === null ? "calc(100vw - 2rem)" : "100vw",
		maxHeight: overlayRowSize(layout.maxHeight) ?? "min(70vh, 44rem)",
	};
	let translateX = "0";
	let translateY = "0";

	if (layout.row !== null) {
		style.top = overlayPositionValue(layout.row, "lh");
		const percent = overlayPercent(layout.row);
		if (percent !== null) translateY = `-${percent}%`;
	} else if (layout.anchor.startsWith("top")) {
		style.top = 0;
	} else if (layout.anchor.startsWith("bottom")) {
		style.bottom = 0;
	} else {
		style.top = "50%";
		translateY = "-50%";
	}

	if (layout.col !== null) {
		style.left = overlayPositionValue(layout.col, "ch");
		const percent = overlayPercent(layout.col);
		if (percent !== null) translateX = `-${percent}%`;
	} else if (layout.anchor.endsWith("left")) {
		style.left = 0;
	} else if (layout.anchor.endsWith("right")) {
		style.right = 0;
	} else {
		style.left = "50%";
		translateX = "-50%";
	}

	const transforms: string[] = [];
	if (translateX !== "0" || translateY !== "0") transforms.push(`translate(${translateX}, ${translateY})`);
	if (layout.offsetX !== 0 || layout.offsetY !== 0) {
		transforms.push(`translate(${layout.offsetX}ch, ${layout.offsetY}lh)`);
	}
	if (transforms.length > 0) style.transform = transforms.join(" ");
	return style;
}

export function ExtensionCustomPanel({
	sessionRef,
	panel,
	onError,
}: {
	sessionRef: SessionRef | null;
	panel: ExtensionUiStateSnapshot["customPanel"];
	onError: (error: unknown) => void;
}) {
	const hostSessionApi = useDomainApi("session");

	const { t } = useTranslation();
	const panelRef = useRef<HTMLDivElement | null>(null);
	const panelFocusStateRef = useRef(EMPTY_CUSTOM_PANEL_FOCUS_STATE);
	const lastViewportKeyRef = useRef<string | null>(null);
	const lastViewportSessionKeyRef = useRef<string | null>(null);
	const shouldFocusPanel = panel !== null && !panel.hidden && panel.focused;

	useEffect(() => {
		panelFocusStateRef.current = synchronizeCustomPanelFocus(
			panelFocusStateRef.current,
			panelRef.current,
			typeof document === "undefined" ? null : document.activeElement,
			shouldFocusPanel,
		);
		return () => {
			if (!shouldFocusPanel) return;
			panelFocusStateRef.current = synchronizeCustomPanelFocus(panelFocusStateRef.current, null, null, false);
		};
	}, [shouldFocusPanel]);

	useEffect(() => {
		if (!sessionRef) return;
		const currentSessionKey = sessionKey(sessionRef);
		if (lastViewportSessionKeyRef.current !== currentSessionKey) {
			lastViewportSessionKeyRef.current = currentSessionKey;
			lastViewportKeyRef.current = null;
		}
		const reportViewport = () => {
			const viewport = measureExtensionViewport();
			if (!viewport) return;
			const key = `${viewport.columns}:${viewport.rows}:${viewport.markdownColumns}:${viewport.dockColumns}`;
			if (lastViewportKeyRef.current === key) return;
			lastViewportKeyRef.current = key;
			void hostSessionApi.updateExtensionUiViewport({ ref: sessionRef, ...viewport }).catch(onError);
		};
		reportViewport();
		const animationFrame = requestAnimationFrame(reportViewport);
		window.addEventListener("resize", reportViewport);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reportViewport);
		observer?.observe(document.documentElement);
		const timeline = document.querySelector<HTMLElement>("[data-timeline-rows]");
		if (timeline) observer?.observe(timeline);
		return () => {
			cancelAnimationFrame(animationFrame);
			window.removeEventListener("resize", reportViewport);
			observer?.disconnect();
		};
	}, [hostSessionApi, sessionRef, onError]);

	if (!sessionRef || !panel || panel.hidden) return null;

	const sendInput = (data: string) => {
		void hostSessionApi.sendExtensionUiInput({ ref: sessionRef, data }).catch(onError);
	};

	const passive = isPassiveCustomPanel(panel.layout.nonCapturing, panel.focused);

	return (
		<div
			className={cn("fixed inset-0 z-50", panel.layout.nonCapturing ? "bg-transparent" : "bg-black/25", {
				"pointer-events-none": passive,
			})}
			style={customPanelShellStyle(panel.layout)}
		>
			{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the panel already carries role="dialog", tabIndex and its own onKeyDown; the pointer listeners only forward extension events */}
			<div
				ref={panelRef}
				data-extension-custom-panel={true}
				role="dialog"
				aria-modal={panel.focused && !panel.layout.nonCapturing}
				tabIndex={passive ? -1 : 0}
				onKeyDown={(event) => {
					const data = extensionKeyData(event);
					if (data === null) return;
					event.preventDefault();
					event.stopPropagation();
					sendInput(data);
				}}
				style={customPanelStyle(panel.layout)}
				className={cn(
					"flex min-w-0 flex-col overflow-hidden rounded-control border border-border-subtle bg-surface shadow-xl outline-none ring-1 ring-black/5",
					passive ? "pointer-events-none" : "pointer-events-auto",
				)}
			>
				<div className="flex min-h-9 items-center justify-end border-border-subtle border-b px-2">
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									onClick={() => sendInput("\x1b")}
									className="flex size-7 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
									aria-label={t("extensionUi.closeEnvironment")}
									tabIndex={passive ? -1 : 0}
								/>
							}
						>
							<X className="size-4" aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent>Esc</TooltipContent>
					</Tooltip>
				</div>
				<ExtensionLinesBlock
					lines={panel.lines}
					className="min-h-0 overflow-auto p-3 font-mono text-xs leading-relaxed text-text-primary"
				/>
			</div>
		</div>
	);
}
