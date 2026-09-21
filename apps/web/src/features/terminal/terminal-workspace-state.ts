import { createTerminalPane, findTerminalPane, type TerminalLayoutNode, terminalPaneLeaves } from "./terminal-layout";

export interface ProjectTerminalWorkspace {
	cwd: string;
	terminalIds: string[];
	root: TerminalLayoutNode | null;
	activePaneId: string | null;
}

const workspaceCache = new Map<string, ProjectTerminalWorkspace>();

function cloneLayout(node: TerminalLayoutNode): TerminalLayoutNode {
	return structuredClone(node);
}

function retainAvailablePanes(
	node: TerminalLayoutNode,
	availableTerminalIds: ReadonlySet<string>,
): TerminalLayoutNode | null {
	if (node.kind === "leaf") return availableTerminalIds.has(node.terminalId) ? { ...node } : null;
	const first = retainAvailablePanes(node.first, availableTerminalIds);
	const second = retainAvailablePanes(node.second, availableTerminalIds);
	if (first === null) return second;
	if (second === null) return first;
	return { ...node, first, second };
}

export function restoreProjectTerminalWorkspace(cwd: string): ProjectTerminalWorkspace {
	const cached = workspaceCache.get(cwd);
	if (!cached) return { cwd, terminalIds: [], root: null, activePaneId: null };
	return {
		cwd,
		terminalIds: [...cached.terminalIds],
		root: cached.root ? cloneLayout(cached.root) : null,
		activePaneId: cached.activePaneId,
	};
}

export function reconcileProjectTerminalWorkspace(
	workspace: ProjectTerminalWorkspace,
	availableTerminalIds: readonly string[],
): ProjectTerminalWorkspace {
	const available = new Set(availableTerminalIds);
	const terminalIds = [
		...workspace.terminalIds.filter((terminalId) => available.has(terminalId)),
		...availableTerminalIds.filter((terminalId) => !workspace.terminalIds.includes(terminalId)),
	];
	let root = workspace.root ? retainAvailablePanes(workspace.root, available) : null;
	if (root === null && terminalIds.length > 0) root = createTerminalPane(terminalIds[0] as string);
	const leaves = root ? terminalPaneLeaves(root) : [];
	const activePaneId =
		root && workspace.activePaneId && findTerminalPane(root, workspace.activePaneId)
			? workspace.activePaneId
			: (leaves[0]?.paneId ?? null);
	return { cwd: workspace.cwd, terminalIds, root, activePaneId };
}

export function rememberProjectTerminalWorkspace(workspace: ProjectTerminalWorkspace): void {
	if (workspace.terminalIds.length === 0) {
		workspaceCache.delete(workspace.cwd);
		return;
	}
	workspaceCache.set(workspace.cwd, {
		cwd: workspace.cwd,
		terminalIds: [...workspace.terminalIds],
		root: workspace.root ? cloneLayout(workspace.root) : null,
		activePaneId: workspace.activePaneId,
	});
}

/** Drop cached layout for a closed project so the map cannot retain closed cwds forever. */
export function forgetProjectTerminalWorkspace(cwd: string): void {
	workspaceCache.delete(cwd);
}
