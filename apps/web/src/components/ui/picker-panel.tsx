import { cn } from "@renderer/lib/utils";
import { autoUpdate, flip, offset, shift, size, useFloating } from "@floating-ui/react-dom";
import {
	type ComponentProps,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { menuContentClass } from "./menu-styles";

/** Anchored selection never participates in its field's layout or traps page focus. */
export function PickerPopover({
	anchorRef,
	placement,
	children,
}: {
	anchorRef: RefObject<HTMLElement | null>;
	placement: "top-start" | "bottom-end";
	children: ReactNode;
}) {
	const { refs, floatingStyles, isPositioned } = useFloating({
		open: true,
		placement,
		strategy: "fixed",
		whileElementsMounted: autoUpdate,
		middleware: [
			offset(6),
			flip({ padding: 8 }),
			shift({ padding: 8, crossAxis: true }),
			size({
				padding: 8,
				apply({ availableWidth, availableHeight, elements }) {
					elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
					// The preferred height stays fixed until the viewport (including an on-screen keyboard) cannot fit it.
					elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
				},
			}),
		],
	});
	useLayoutEffect(() => {
		refs.setReference(anchorRef.current);
	}, [anchorRef, refs]);
	// A containing dialog owns focus and accessibility; keep its picker within that boundary.
	const container = anchorRef.current?.closest('[role="dialog"]') ?? document.body;
	return createPortal(
		<div
			ref={refs.setFloating}
			style={{ ...floatingStyles, visibility: isPositioned ? "visible" : "hidden" }}
			className="z-50 h-76 w-110 max-w-[calc(100vw-1rem)]"
		>
			{isPositioned && children}
		</div>,
		container,
	);
}

/** A bounded choice surface. Result counts never move its search field or footer. */
export function PickerPanel({
	className,
	id,
	onEscapeKeyDown,
	...props
}: ComponentProps<"div"> & {
	onEscapeKeyDown: (event: KeyboardEvent) => void;
}) {
	const generatedId = useId();
	const panelId = id ?? generatedId;
	useEffect(() => {
		const onEscape = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				!(event.target instanceof Element) ||
				event.target.closest('[data-slot="picker-panel"]')?.id !== panelId
			)
				return;
			// Handle the picker before a containing dialog's document-level Escape listener.
			event.preventDefault();
			event.stopPropagation();
			onEscapeKeyDown(event);
		};
		window.addEventListener("keydown", onEscape, true);
		return () => window.removeEventListener("keydown", onEscape, true);
	}, [panelId, onEscapeKeyDown]);
	return (
		<div
			id={panelId}
			data-slot="picker-panel"
			className={cn(
				menuContentClass,
				"@container/picker flex h-full min-h-0 w-full flex-col gap-1 overflow-hidden rounded-panel p-1.5",
				className,
			)}
			{...props}
		/>
	);
}

/** One Tab stop for a choice rail; arrows move focus and Enter confirms without selecting a neighboring list. */
export function PickerRail({
	label,
	items,
	value,
	onSelect,
}: {
	label: string;
	items: readonly { value: string; label: string; content: ReactNode }[];
	value: string;
	onSelect: (value: string) => void;
}) {
	const [focused, setFocused] = useState(value);
	const rootRef = useRef<HTMLDivElement>(null);
	const active = items.some((item) => item.value === focused)
		? focused
		: items.some((item) => item.value === value)
			? value
			: items[0]?.value;
	const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== "Escape") event.stopPropagation();
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
		const current = buttons.indexOf(event.currentTarget);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
		buttons[next]?.focus({ preventScroll: true });
		buttons[next]?.scrollIntoView({ block: "nearest" });
	};
	return (
		<div ref={rootRef} role="group" aria-label={label} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
			{items.map((item) => (
				<Button
					key={item.value}
					type="button"
					variant="ghost"
					size="sm"
					tabIndex={item.value === active ? 0 : -1}
					aria-pressed={item.value === value}
					title={item.label}
					className="min-h-7 w-full justify-between gap-1 px-1.5 text-left text-xs font-normal aria-pressed:bg-surface-hover"
					onFocus={() => setFocused(item.value)}
					onKeyDown={onKeyDown}
					onClick={() => onSelect(item.value)}
				>
					{item.content}
				</Button>
			))}
		</div>
	);
}
