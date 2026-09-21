import { createLogger } from "./logger";

const log = createLogger("listeners");

/** One broken listener must never escape into the Pi SDK dispatch loop or block peers. */
export function notifyListeners<Args extends unknown[]>(
	listeners: Iterable<(...args: Args) => void>,
	label: string,
	...args: Args
): void {
	for (const listener of listeners) {
		try {
			listener(...args);
		} catch (error) {
			log.error(`${label} listener failed:`, error);
		}
	}
}
