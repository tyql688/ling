import { cn } from "@renderer/lib/utils";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
	type TerminalLayoutNode,
	type TerminalPaneLeaf,
	type TerminalSplitNode,
	terminalPaneLeaves,
} from "./terminal-layout";
import type { TerminalController } from "./use-terminal-controller";

interface TerminalLeafProps {
	cwd: string;
	leaf: TerminalPaneLeaf;
	active: boolean;
	showHeader: boolean;
	controller: TerminalController;
}

function TerminalLeaf({ cwd, leaf, active, showHeader, controller }: TerminalLeafProps) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const runtime = controller.getRuntime(leaf.terminalId);
	const mountTerminal = controller.mountTerminal;
	const fitTerminal = controller.fitTerminal;
	const focusTerminal = controller.focusTerminal;

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !runtime) return undefined;
		const unmount = mountTerminal(leaf.terminalId, container);
		let frame = 0;
		const fit = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => fitTerminal(leaf.terminalId));
		};
		const observer = new ResizeObserver(fit);
		observer.observe(container);
		fit();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			unmount();
		};
	}, [fitTerminal, leaf.terminalId, mountTerminal, runtime]);

	useEffect(() => {
		if (!active || !runtime) return undefined;
		const frame = requestAnimationFrame(() => focusTerminal(leaf.terminalId));
		return () => cancelAnimationFrame(frame);
	}, [active, focusTerminal, leaf.terminalId, runtime]);

	if (!runtime) return null;
	return (
		<section
			className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent"
			onPointerDown={() => controller.focusPane(cwd, leaf.paneId)}
			data-terminal-pane={leaf.paneId}
		>
			{showHeader && (
				<div
					className={cn(
						"flex h-7 shrink-0 items-center gap-2 border-border-subtle border-b px-2 text-xs transition-colors",
						active && "bg-surface-hover",
					)}
				>
					<span className="min-w-0 flex-1 truncate text-text-muted">{runtime.title}</span>
					{runtime.snapshot.status === "exited" && (
						<span className="shrink-0 rounded-sm bg-surface-raised px-1.5 py-0.5 text-text-muted">
							{t("terminal.exited")}
						</span>
					)}
				</div>
			)}
			<div ref={containerRef} className="terminal-xterm-host min-h-0 min-w-0 flex-1 px-2 py-1.5" />
			{runtime.replayTruncated && (
				<div className="pointer-events-none absolute right-2 bottom-2 rounded-sm bg-workbench-chrome px-2 py-1 text-xs text-text-muted shadow-sm">
					{t("terminal.olderOutputTruncated")}
				</div>
			)}
		</section>
	);
}

interface TerminalSplitProps {
	cwd: string;
	node: TerminalSplitNode;
	activePaneId: string | null;
	controller: TerminalController;
	showHeaders: boolean;
}

function TerminalSplit({ cwd, node, activePaneId, controller, showHeaders }: TerminalSplitProps) {
	const { t } = useTranslation();
	const horizontal = node.direction === "horizontal";
	const firstPanelId = `${node.splitId}-first`;
	const secondPanelId = `${node.splitId}-second`;

	return (
		<Group
			id={node.splitId}
			orientation={horizontal ? "horizontal" : "vertical"}
			defaultLayout={{
				[firstPanelId]: node.ratio * 100,
				[secondPanelId]: (1 - node.ratio) * 100,
			}}
			onLayoutChanged={(layout, metadata) => {
				if (!metadata.isUserInteraction) return;
				const firstSize = layout[firstPanelId];
				if (firstSize !== undefined) controller.setSplitRatio(cwd, node.splitId, firstSize / 100);
				for (const leaf of terminalPaneLeaves(node)) controller.fitTerminal(leaf.terminalId);
			}}
			resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}
			className="min-h-0 min-w-0 flex-1"
			data-terminal-split={node.splitId}
		>
			<Panel id={firstPanelId} minSize="20%" maxSize="80%" className="flex min-h-0 min-w-0">
				<TerminalLayout
					cwd={cwd}
					node={node.first}
					activePaneId={activePaneId}
					controller={controller}
					showHeaders={showHeaders}
				/>
			</Panel>
			<Separator
				id={`${node.splitId}-separator`}
				aria-label={t("terminal.resizePanes")}
				className={cn(
					"relative z-10 shrink-0 bg-border-subtle outline-none transition-colors hover:bg-text-muted/35 focus-visible:bg-text-muted/55 data-[separator=active]:bg-text-muted/55",
					horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
				)}
			/>
			<Panel id={secondPanelId} minSize="20%" className="flex min-h-0 min-w-0">
				<TerminalLayout
					cwd={cwd}
					node={node.second}
					activePaneId={activePaneId}
					controller={controller}
					showHeaders={showHeaders}
				/>
			</Panel>
		</Group>
	);
}

interface TerminalLayoutProps {
	cwd: string;
	node: TerminalLayoutNode;
	activePaneId: string | null;
	controller: TerminalController;
	showHeaders?: boolean | undefined;
}

export function TerminalLayout({ cwd, node, activePaneId, controller, showHeaders = false }: TerminalLayoutProps) {
	if (node.kind === "split") {
		return (
			<TerminalSplit
				cwd={cwd}
				node={node}
				activePaneId={activePaneId}
				controller={controller}
				showHeaders={showHeaders}
			/>
		);
	}
	return (
		<TerminalLeaf
			cwd={cwd}
			leaf={node}
			active={node.paneId === activePaneId}
			showHeader={showHeaders}
			controller={controller}
		/>
	);
}
