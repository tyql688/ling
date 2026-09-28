import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export function WorkbenchDivider({
	label,
	value,
	min,
	max,
	direction = 1,
	onChange,
	onCommit,
	onDragging,
	onReset,
	style,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	direction?: number;
	onChange(value: number): void;
	onCommit(value: number): void;
	onDragging?(value: boolean): void;
	onReset(): void;
	style: React.CSSProperties;
}) {
	const drag = useRef<{ start: number; value: number; next: number } | null>(null);
	const bound = (size: number) => Math.max(min, Math.min(max, size));
	const end = (event: PointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		const next = drag.current.next;
		drag.current = null;
		onDragging?.(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		onCommit(next);
	};
	const keys = (event: KeyboardEvent<HTMLDivElement>) => {
		const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
		if (!delta && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		onCommit(
			event.key === "Home"
				? min
				: event.key === "End"
					? max
					: bound(value + delta * direction * (event.shiftKey ? 40 : 10)),
		);
	};
	/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable ARIA window splitter supports pointer, arrow, Home and End resizing. */
	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation="vertical"
			aria-valuenow={Math.round(value)}
			aria-valuemin={min}
			aria-valuemax={Math.round(max)}
			tabIndex={0}
			className="workbench-column-divider absolute inset-y-0 z-40 w-px cursor-col-resize outline-none"
			style={style}
			onKeyDown={keys}
			onDoubleClick={onReset}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				drag.current = { start: event.clientX, value, next: value };
				event.currentTarget.setPointerCapture(event.pointerId);
				onDragging?.(true);
			}}
			onPointerMove={(event) => {
				if (!drag.current) return;
				const next = bound(drag.current.value + (event.clientX - drag.current.start) * direction);
				drag.current.next = next;
				onChange(next);
			}}
			onPointerUp={end}
			onPointerCancel={end}
			onLostPointerCapture={end}
		/>
	);
}
/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
