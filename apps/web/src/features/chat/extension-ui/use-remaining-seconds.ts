import { useEffect, useState } from "react";

/**
 * Countdown UI refresh interval. 250ms keeps second changes smooth without a setState per frame.
 */
const COUNTDOWN_REFRESH_MS = 250;

function remainingSecondsUntil(expiresAt: number, now: number): number {
	return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function useRemainingSeconds(expiresAt: number | null): number | null {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (expiresAt === null) return;
		const timer = window.setInterval(() => setNow(Date.now()), COUNTDOWN_REFRESH_MS);
		return () => window.clearInterval(timer);
	}, [expiresAt]);

	return expiresAt === null ? null : remainingSecondsUntil(expiresAt, now);
}
