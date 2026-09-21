import {
	GIT_GRAPH_CIRCLE_RADIUS,
	GIT_GRAPH_CIRCLE_STROKE_WIDTH,
	GIT_GRAPH_CURVE_RADIUS,
	GIT_GRAPH_LANE_GAP,
	GIT_GRAPH_ROW_HEIGHT,
	GIT_GRAPH_ROW_MIDDLE,
	type GitGraphRow,
} from "./git-graph-layout";

/* Licensed derivative; see THIRD_PARTY_NOTICES.md. */

/** Lane stroke/fill color tokens; index = color % GIT_GRAPH_LANE_COLOR_COUNT. */
const GRAPH_COLORS = [
	"var(--color-chart-1)",
	"var(--color-chart-2)",
	"var(--color-chart-3)",
	"var(--color-chart-4)",
	"var(--color-chart-5)",
] as const;

function laneX(index: number): number {
	return GIT_GRAPH_LANE_GAP * (index + 1);
}

/**
 * A lane that keeps its column: one straight segment.
 */
function straightLanePath(x: number, fromY: number, toY: number): string {
	return `M ${x} ${fromY} V ${toY}`;
}

/**
 * A lane that steps sideways because a lane to its left closed on this row.
 *
 * Drawn as VS Code does it — down, quarter turn, across the row's middle, quarter turn, down —
 * rather than as one bezier spanning the whole row. At this size an S-curve reads as a smear:
 * the orthogonal run keeps every lane on an exact column except within the corner radius, so
 * parallel lanes stay visually parallel.
 */
function steppedLanePath(fromX: number, toX: number): string {
	const radius = GIT_GRAPH_CURVE_RADIUS;
	// Sweep direction flips with the step direction; lanes usually shift left, but a lane that
	// opens to the left of an existing one steps right.
	const goingLeft = toX < fromX;
	const firstSweep = goingLeft ? 1 : 0;
	const secondSweep = goingLeft ? 0 : 1;
	const cornerX = goingLeft ? fromX - radius : fromX + radius;
	const exitX = goingLeft ? toX + radius : toX - radius;
	return [
		`M ${fromX} 0`,
		`V ${GIT_GRAPH_ROW_MIDDLE - radius}`,
		`A ${radius} ${radius} 0 0 ${firstSweep} ${cornerX} ${GIT_GRAPH_ROW_MIDDLE}`,
		`H ${exitX}`,
		`A ${radius} ${radius} 0 0 ${secondSweep} ${toX} ${GIT_GRAPH_ROW_MIDDLE + radius}`,
		`V ${GIT_GRAPH_ROW_HEIGHT}`,
	].join(" ");
}

/**
 * The commit's own lane arrives in a column the node does not occupy, so the lane curves in
 * from above and runs across to the node. VS Code draws this with a single quarter ellipse
 * whose radii are the lane gap and the row's half height, which keeps the curve inside one row
 * regardless of how tall the row is.
 */
function inboundNodePath(fromX: number, nodeX: number): string {
	const goingLeft = nodeX < fromX;
	const arcEndX = goingLeft ? fromX - GIT_GRAPH_LANE_GAP : fromX + GIT_GRAPH_LANE_GAP;
	return [
		`M ${fromX} 0`,
		// Run straight down first, then turn on a circular arc. VS Code writes this as one arc
		// because its lane gap happens to equal half its row height; keeping the arc circular
		// and absorbing the extra height in the straight run is what preserves the shape here.
		`V ${GIT_GRAPH_ROW_MIDDLE - GIT_GRAPH_LANE_GAP}`,
		`A ${GIT_GRAPH_LANE_GAP} ${GIT_GRAPH_LANE_GAP} 0 0 ${goingLeft ? 1 : 0} ${arcEndX} ${GIT_GRAPH_ROW_MIDDLE}`,
		`H ${nodeX}`,
	].join(" ");
}

/**
 * A merge's second and later parents: the lane leaves the node sideways at the row's middle and
 * curves down into its own column.
 */
function outboundParentPath(nodeX: number, toX: number): string {
	const goingLeft = toX < nodeX;
	const arcStartX = goingLeft ? toX + GIT_GRAPH_LANE_GAP : toX - GIT_GRAPH_LANE_GAP;
	return [
		// Leave the node horizontally, turn on a circular arc, then drop straight to the row edge.
		`M ${nodeX} ${GIT_GRAPH_ROW_MIDDLE}`,
		`H ${arcStartX}`,
		`A ${GIT_GRAPH_LANE_GAP} ${GIT_GRAPH_LANE_GAP} 0 0 ${goingLeft ? 0 : 1} ${toX} ${GIT_GRAPH_ROW_MIDDLE + GIT_GRAPH_LANE_GAP}`,
		`V ${GIT_GRAPH_ROW_HEIGHT}`,
	].join(" ");
}

interface GraphConnection {
	key: string;
	path: string;
	color: number;
}

function graphConnections(row: GitGraphRow): GraphConnection[] {
	const connections: GraphConnection[] = [];
	const nodeX = laneX(row.nodeIndex);
	const inputIndex = row.input.findIndex((lane) => lane.id === row.commit.sha);

	// Walk the input lanes in order and pair each surviving lane with its output column, the way
	// VS Code advances a single output cursor. Pairing by order rather than by search keeps two
	// lanes that carry the same parent from both claiming the same output column.
	let outputCursor = 0;
	for (let index = 0; index < row.input.length; index += 1) {
		const lane = row.input[index];
		if (!lane) continue;

		if (lane.id === row.commit.sha) {
			// The commit's own lane. When the node sits in this column the vertical stub below
			// draws it; otherwise the lane has to reach across to the node.
			if (index !== row.nodeIndex) {
				connections.push({ key: `inbound-${index}`, path: inboundNodePath(laneX(index), nodeX), color: lane.color });
			} else {
				outputCursor += 1;
			}
			continue;
		}

		const output = row.output[outputCursor];
		if (!output || output.id !== lane.id) continue;
		connections.push({
			key: `lane-${index}-${outputCursor}`,
			path:
				index === outputCursor
					? straightLanePath(laneX(index), 0, GIT_GRAPH_ROW_HEIGHT)
					: steppedLanePath(laneX(index), laneX(outputCursor)),
			color: lane.color,
		});
		outputCursor += 1;
	}

	// Extra parents of a merge. The first parent continues in the node's own column and is drawn
	// by the stub below, so only parents past the first need their own curve.
	for (let index = 1; index < row.commit.parents.length; index += 1) {
		const parent = row.commit.parents[index];
		if (!parent) continue;
		const outputIndex = row.output.findLastIndex((lane) => lane.id === parent);
		if (outputIndex === -1) continue;
		connections.push({
			key: `parent-${index}-${outputIndex}`,
			path: outboundParentPath(nodeX, laneX(outputIndex)),
			color: row.output[outputIndex]?.color ?? row.nodeColor,
		});
	}

	// Stubs through the node itself, kept separate so the node's own column is always drawn even
	// when the commit has no visible lane above (a branch tip) or below (a root commit).
	if (inputIndex !== -1) {
		connections.push({
			key: "stub-in",
			path: straightLanePath(nodeX, 0, GIT_GRAPH_ROW_MIDDLE),
			color: row.input[inputIndex]?.color ?? row.nodeColor,
		});
	}
	if (row.commit.parents.length > 0) {
		connections.push({
			key: "stub-out",
			path: straightLanePath(nodeX, GIT_GRAPH_ROW_MIDDLE, GIT_GRAPH_ROW_HEIGHT),
			color: row.nodeColor,
		});
	}

	return connections;
}

/**
 * Nodes are stroked with the surface color rather than their lane color: that ring is what keeps
 * a node readable when other lanes pass directly behind it. VS Code gets the same effect from a
 * CSS rule on every circle; stating it here keeps the shape independent of cascade order.
 */
function GraphNode({ x, color, kind }: { x: number; color: string; kind: "head" | "merge" | "commit" }) {
	const surface = "var(--color-surface)";
	const outerRadius =
		kind === "head"
			? GIT_GRAPH_CIRCLE_RADIUS + 3
			: kind === "merge"
				? GIT_GRAPH_CIRCLE_RADIUS + 2
				: GIT_GRAPH_CIRCLE_RADIUS + 1;
	return (
		<>
			<circle
				cx={x}
				cy={GIT_GRAPH_ROW_MIDDLE}
				r={outerRadius}
				fill={color}
				stroke={surface}
				strokeWidth={GIT_GRAPH_CIRCLE_STROKE_WIDTH}
			/>
			{/* HEAD reads as a thick ring, a merge as a donut; a plain commit needs no inner shape. */}
			{kind === "head" && (
				<circle cx={x} cy={GIT_GRAPH_ROW_MIDDLE} r={GIT_GRAPH_CIRCLE_RADIUS} fill={surface} stroke="none" />
			)}
			{kind === "merge" && (
				<circle
					cx={x}
					cy={GIT_GRAPH_ROW_MIDDLE}
					r={GIT_GRAPH_CIRCLE_RADIUS - 1}
					fill={color}
					stroke={surface}
					strokeWidth={GIT_GRAPH_CIRCLE_STROKE_WIDTH}
				/>
			)}
		</>
	);
}

export function GitGraphCell({
	row,
	columnCount,
	headSha,
}: {
	row: GitGraphRow;
	columnCount: number;
	headSha: string | null;
}) {
	const nodeX = laneX(row.nodeIndex);
	const color = GRAPH_COLORS[row.nodeColor % GRAPH_COLORS.length] ?? GRAPH_COLORS[0];
	const kind = row.commit.sha === headSha ? "head" : row.commit.parents.length > 1 ? "merge" : "commit";
	return (
		<svg
			aria-hidden="true"
			className="shrink-0 overflow-visible"
			width={GIT_GRAPH_LANE_GAP * (columnCount + 1)}
			height={GIT_GRAPH_ROW_HEIGHT}
			viewBox={`0 0 ${GIT_GRAPH_LANE_GAP * (columnCount + 1)} ${GIT_GRAPH_ROW_HEIGHT}`}
		>
			{graphConnections(row).map((connection) => (
				<path
					key={connection.key}
					d={connection.path}
					fill="none"
					stroke={GRAPH_COLORS[connection.color % GRAPH_COLORS.length]}
					strokeLinecap="round"
					strokeWidth="1.5"
				/>
			))}
			<GraphNode x={nodeX} color={color} kind={kind} />
		</svg>
	);
}
