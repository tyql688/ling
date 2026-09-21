import type { GitGraphCommit } from "@ling/contracts/git";

/* Licensed derivative; see THIRD_PARTY_NOTICES.md. */

/** Lane color cycle length; aligned with GRAPH_COLORS / chart-1..5. */
const GIT_GRAPH_LANE_COLOR_COUNT = 5;
/** Horizontal spacing between adjacent lanes (px); determines graph width and node coordinates. */
export const GIT_GRAPH_LANE_GAP = 19;
/** Corner radius where a lane steps sideways, matching VS Code's SWIMLANE_CURVE_RADIUS. */
export const GIT_GRAPH_CURVE_RADIUS = 5;
/** Node radius before the per-kind adjustments below, matching VS Code's CIRCLE_RADIUS. */
export const GIT_GRAPH_CIRCLE_RADIUS = 4;
/** Ring thickness that separates a node from the lanes running behind it. */
export const GIT_GRAPH_CIRCLE_STROKE_WIDTH = 2;
/** Commit row height (px); matches the list row layout, and connection lines step by it. */
export const GIT_GRAPH_ROW_HEIGHT = 38;
/** Vertical center line of the node within a row, used to align connection lines and dots. */
export const GIT_GRAPH_ROW_MIDDLE = GIT_GRAPH_ROW_HEIGHT / 2;

interface GitGraphLane {
	id: string;
	color: number;
}

export interface GitGraphRow {
	commit: GitGraphCommit;
	input: GitGraphLane[];
	output: GitGraphLane[];
	nodeIndex: number;
	nodeColor: number;
}

interface GitGraphLayout {
	rows: GitGraphRow[];
	columnCount: number;
}

export function layoutGitGraph(commits: readonly GitGraphCommit[]): GitGraphLayout {
	const rows: GitGraphRow[] = [];
	let color = -1;
	let lanes: GitGraphLane[] = [];
	let columnCount = 1;
	const nextColor = (): number => {
		color = (color + 1) % GIT_GRAPH_LANE_COLOR_COUNT;
		return color;
	};

	for (const commit of commits) {
		const input = lanes.map((lane) => ({ ...lane }));
		const output: GitGraphLane[] = [];
		let firstParentAdded = false;

		for (const lane of input) {
			if (lane.id !== commit.sha) {
				output.push({ ...lane });
				continue;
			}
			if (!firstParentAdded && commit.parents[0]) {
				output.push({ id: commit.parents[0], color: lane.color });
				firstParentAdded = true;
			}
		}

		for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index += 1) {
			const parent = commit.parents[index];
			if (parent) output.push({ id: parent, color: nextColor() });
		}

		const inputIndex = input.findIndex((lane) => lane.id === commit.sha);
		const nodeIndex = inputIndex === -1 ? input.length : inputIndex;
		const nodeColor = output[nodeIndex]?.color ?? input[nodeIndex]?.color ?? nextColor();
		rows.push({ commit, input, output, nodeIndex, nodeColor });
		lanes = output;
		columnCount = Math.max(columnCount, input.length, output.length, nodeIndex + 1);
	}

	return { rows, columnCount };
}
