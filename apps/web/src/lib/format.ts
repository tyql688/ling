/**
 * Cost display: below this value use 4 decimals, otherwise 2 (avoids $0.00 swallowing micro costs).
 */
const COST_MICRO_THRESHOLD = 0.01;

export function formatCost(cost: number): string {
	return cost < COST_MICRO_THRESHOLD ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
