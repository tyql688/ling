import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Three rows of three cells form the compact chevron wavefront. */
const GRID_SIDE = 3;
/** Adjacent columns trail the wave by 90ms; the 650ms CSS cycle overlaps successive fronts. */
const CELL_DELAY_MS = 90;
const CELL_DELAYS = Array.from({ length: GRID_SIDE * GRID_SIDE }, (_, index) => {
	const row = Math.floor(index / GRID_SIDE);
	const column = index % GRID_SIDE;
	return { id: `${row}:${column}`, delay: (column + Math.abs(row - 1)) * CELL_DELAY_MS };
});
/** Tenths match the requested live timer without driving the transcript's render loop. */
const CLOCK_INTERVAL_MS = 100;
/** Milliseconds per second and seconds per minute for the elapsed label. */
const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;

function WorkingElapsed({ startedAt }: { startedAt: number | undefined }) {
	const { t } = useTranslation();
	// A new run can be busy before its first timestamped message arrives.
	const mountedAt = useRef(Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, []);
	const elapsed = Math.max(0, (now - (startedAt ?? mountedAt.current)) / SECOND_MS);
	const duration =
		elapsed < MINUTE_SECONDS
			? t("session.workingElapsedSeconds", { seconds: elapsed.toFixed(1) })
			: t("session.workingElapsedMinutes", {
					minutes: Math.floor(elapsed / MINUTE_SECONDS),
					seconds: (elapsed % MINUTE_SECONDS).toFixed(1),
				});
	// Reserve the localized glyph width independently of the ticking text. The absolute
	// label then repaints its own box without laying out the transcript ten times a second.
	const measure =
		elapsed < MINUTE_SECONDS
			? t("session.workingElapsedSeconds", { seconds: "00.0" })
			: t("session.workingElapsedMinutes", {
					minutes: "0".repeat(String(Math.floor(elapsed / MINUTE_SECONDS)).length),
					seconds: "00.0",
				});
	return (
		<span
			aria-hidden="true"
			className="relative inline-block font-mono text-xs tabular-nums text-text-muted [contain:layout_paint]"
		>
			<span className="invisible">{measure}</span>
			<span className="absolute inset-0">{duration}</span>
		</span>
	);
}

export function WorkingIndicator({ startedAt }: { startedAt: number | undefined }) {
	const { t } = useTranslation();
	const label = t("session.workingLabel");
	return (
		<span role="status" className="inline-flex items-center gap-2.5" aria-label={label}>
			<span aria-hidden="true" className="working-grid">
				{CELL_DELAYS.map(({ id, delay }) => (
					<span key={id} className="working-grid-cell" style={{ animationDelay: `${delay}ms` }} />
				))}
			</span>
			<span className="working-label">
				<span>{label}</span>
				<span aria-hidden="true" className="working-shimmer-window">
					<span>{label}</span>
				</span>
			</span>
			<WorkingElapsed startedAt={startedAt} />
		</span>
	);
}
