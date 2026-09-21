export type TerminalSplitDirection = "horizontal" | "vertical";

export interface TerminalPaneLeaf {
	kind: "leaf";
	paneId: string;
	terminalId: string;
}

export interface TerminalSplitNode {
	kind: "split";
	splitId: string;
	direction: TerminalSplitDirection;
	ratio: number;
	first: TerminalLayoutNode;
	second: TerminalLayoutNode;
}

export type TerminalLayoutNode = TerminalPaneLeaf | TerminalSplitNode;

export function createTerminalPane(terminalId: string): TerminalPaneLeaf {
	return { kind: "leaf", paneId: crypto.randomUUID(), terminalId };
}

export function terminalPaneLeaves(node: TerminalLayoutNode): TerminalPaneLeaf[] {
	if (node.kind === "leaf") return [node];
	return [...terminalPaneLeaves(node.first), ...terminalPaneLeaves(node.second)];
}

export function findTerminalPane(node: TerminalLayoutNode, paneId: string): TerminalPaneLeaf | null {
	if (node.kind === "leaf") return node.paneId === paneId ? node : null;
	return findTerminalPane(node.first, paneId) ?? findTerminalPane(node.second, paneId);
}

export function findPaneForTerminal(node: TerminalLayoutNode, terminalId: string): TerminalPaneLeaf | null {
	if (node.kind === "leaf") return node.terminalId === terminalId ? node : null;
	return findPaneForTerminal(node.first, terminalId) ?? findPaneForTerminal(node.second, terminalId);
}

function replacePane(
	node: TerminalLayoutNode,
	paneId: string,
	replacement: (leaf: TerminalPaneLeaf) => TerminalLayoutNode,
): TerminalLayoutNode {
	if (node.kind === "leaf") return node.paneId === paneId ? replacement(node) : node;
	const first = replacePane(node.first, paneId, replacement);
	const second = replacePane(node.second, paneId, replacement);
	return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function assignTerminalToPane(node: TerminalLayoutNode, paneId: string, terminalId: string): TerminalLayoutNode {
	return replacePane(node, paneId, (leaf) => ({ ...leaf, terminalId }));
}

export function splitTerminalPane(
	node: TerminalLayoutNode,
	paneId: string,
	terminalId: string,
	direction: TerminalSplitDirection,
): { root: TerminalLayoutNode; paneId: string } {
	const pane = createTerminalPane(terminalId);
	return {
		root: replacePane(node, paneId, (leaf) => ({
			kind: "split",
			splitId: crypto.randomUUID(),
			direction,
			ratio: 0.5,
			first: leaf,
			second: pane,
		})),
		paneId: pane.paneId,
	};
}

export function removeTerminalPane(node: TerminalLayoutNode, terminalId: string): TerminalLayoutNode | null {
	if (node.kind === "leaf") return node.terminalId === terminalId ? null : node;
	const first = removeTerminalPane(node.first, terminalId);
	const second = removeTerminalPane(node.second, terminalId);
	if (first === null) return second;
	if (second === null) return first;
	return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function updateTerminalSplitRatio(node: TerminalLayoutNode, splitId: string, ratio: number): TerminalLayoutNode {
	if (node.kind === "leaf") return node;
	if (node.splitId === splitId) return { ...node, ratio: Math.min(0.8, Math.max(0.2, ratio)) };
	const first = updateTerminalSplitRatio(node.first, splitId, ratio);
	const second = updateTerminalSplitRatio(node.second, splitId, ratio);
	return first === node.first && second === node.second ? node : { ...node, first, second };
}
