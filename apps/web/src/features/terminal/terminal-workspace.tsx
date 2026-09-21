import { useTerminals } from "./use-terminal-controller";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { PanelBoundary } from "@renderer/components/error-fallback";
import { usePanelSizeCommit } from "@renderer/components/workbench/use-panel-size-commit";
import {
	RENDERER_PREFERENCE_KEYS,
	readRendererPreference,
	writeRendererPreference,
} from "@renderer/lib/preferences/renderer-preferences";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Group, Panel, Separator, usePanelCallbackRef } from "react-resizable-panels";
import { TerminalPanel } from "./terminal-panel";

/** Preserve a usable conversation above the terminal; tiny viewports may constrain both minima. */
const DEFAULT_HEIGHT = 300,
	MIN_HEIGHT = 180,
	STORED_HEIGHT_LIMIT = 2000;
function readHeight(): number {
	return readRendererPreference(RENDERER_PREFERENCE_KEYS.terminalPanelHeight, DEFAULT_HEIGHT, (raw) => {
		const height = Number(raw);
		return Number.isSafeInteger(height) && height >= MIN_HEIGHT && height <= STORED_HEIGHT_LIMIT ? height : null;
	}).value;
}

/** The main panel stays mounted while the terminal opens, closes or changes size. */
export function TerminalWorkspace({
	children,
	cwd,
	open,
	onOpenChange,
	onHeightChange,
}: {
	children: ReactNode;
	cwd: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onHeightChange: (height: number) => void;
}) {
	const controller = useTerminals();
	const onError = useCommandFeedback();
	const props = {
		cwd,
		controller,
		open,
		onOpenChange,
		onError,
	};
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (!open) onHeightChange(0);
	}, [open, onHeightChange]);
	const [height, setHeight] = useState(readHeight);
	const [panel, panelRef] = usePanelCallbackRef();
	const sizeCommit = usePanelSizeCommit(panel, (pixels) => {
		setHeight(pixels);
		writeRendererPreference(RENDERER_PREFERENCE_KEYS.terminalPanelHeight, String(pixels));
		for (const id of props.controller.getWorkspace(props.cwd)?.terminalIds ?? []) props.controller.fitTerminal(id);
	});
	useLayoutEffect(() => {
		if (!props.open || !panel) return;
		const restore = () => panel.resize(height);
		restore();
		// Viewport constraints may shrink the panel; they must not replace the saved preferred size.
		window.addEventListener("resize", restore);
		return () => window.removeEventListener("resize", restore);
	}, [height, panel, props.open]);
	return (
		<Group
			elementRef={containerRef}
			orientation="vertical"
			className="flex min-h-0 min-w-0 flex-1"
			onLayoutChanged={sizeCommit.onLayoutChanged}
		>
			<Panel id="content" minSize={240} className="flex min-h-0 min-w-0 flex-col">
				{children}
			</Panel>
			{props.open && (
				<>
					<Separator
						disableDoubleClick
						onDoubleClick={() => sizeCommit.reset(DEFAULT_HEIGHT)}
						aria-label={t("terminal.resizePanel")}
						className="pointer-events-auto h-px bg-border-subtle outline-none data-[separator=hover]:bg-text-muted data-[separator=focus]:bg-text-muted data-[separator=active]:bg-text-muted"
					/>
					<Panel
						id="terminal"
						onResize={(size) => onHeightChange(size.inPixels)}
						panelRef={panelRef}
						defaultSize={DEFAULT_HEIGHT}
						minSize={MIN_HEIGHT}
						maxSize="72vh"
						groupResizeBehavior="preserve-pixel-size"
						className="pointer-events-auto flex min-h-0 min-w-0 flex-col"
					>
						<PanelBoundary resetKeys={[props.cwd]}>
							<TerminalPanel {...props} />
						</PanelBoundary>
					</Panel>
				</>
			)}
		</Group>
	);
}
