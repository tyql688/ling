import { animate } from "motion/react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useLayoutEffect, useRef } from "react";

/**
 * Numeric display that counts up from 0 on mount and glides between value changes.
 * The formatter runs on every animation frame, so it must be pure and cheap.
 */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const previousRef = useRef<number | null>(null);
	const formatRef = useRef(format);
	formatRef.current = format;
	const reducedMotion = useReducedMotion();

	// Layout effect: the count-up must claim the node before the browser paints the
	// final value the JSX fallback rendered, or large numbers flash once at full size.
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const from = previousRef.current ?? 0;
		previousRef.current = value;
		if (reducedMotion || from === value) {
			node.textContent = formatRef.current(value);
			return;
		}
		const controls = animate(from, value, {
			duration: 0.6,
			ease: [0.22, 1, 0.36, 1],
			onUpdate: (latest) => {
				node.textContent = formatRef.current(latest);
			},
		});
		return () => controls.stop();
	}, [reducedMotion, value]);

	return <span ref={ref}>{format(value)}</span>;
}
