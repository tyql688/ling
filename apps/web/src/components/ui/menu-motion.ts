import { useAtomValue } from "jotai";
import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { animate } from "motion/react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useCallback } from "react";

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"]';
const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * One highlight follows Radix focus in dropdowns, context menus and selects.
 * A callback ref owns each portalled opening; cleanup also runs when motion preferences change.
 */
export function useMenuMotion<T extends HTMLElement>(): (content: T | null) => (() => void) | undefined {
	const reducedMotion = useReducedMotion();
	const skinMotion = useAtomValue(activeSkinAppearanceAtom).motion;
	return useCallback(
		(content: T | null) => {
			if (!content || reducedMotion || skinMotion === "none") return undefined;
			const items = Array.from(content.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
			if (items.length === 0) return undefined;

			// The pill lives inside whichever element scrolls the items, so it scrolls with them.
			const host = content.querySelector<HTMLElement>("[data-radix-select-viewport]") ?? content;
			const originalPosition = host.style.position;
			const needsPosition = getComputedStyle(host).position === "static";
			if (needsPosition) host.style.position = "relative";
			const pill = document.createElement("div");
			pill.className = "menu-glide";
			pill.setAttribute("aria-hidden", "true");
			host.prepend(pill);
			content.dataset.menuGlide = "";

			let focused: HTMLElement | null = null;
			let visible = false;
			let pillAnimation: ReturnType<typeof animate> | null = null;
			const moveTo = (item: HTMLElement, instant = false) => {
				if (focused !== item) {
					if (focused) resize.unobserve(focused);
					focused = item;
					resize.observe(item);
				}
				// Layout coordinates stay constant while the popup's entrance animation scales it.
				// Viewport rectangles would bake the opening scale into the highlight until the next focus.
				let x = item.offsetLeft;
				let y = item.offsetTop;
				for (
					let parent = item.offsetParent;
					parent instanceof HTMLElement && parent !== host;
					parent = parent.offsetParent
				) {
					x += parent.offsetLeft + parent.clientLeft - parent.scrollLeft;
					y += parent.offsetTop + parent.clientTop - parent.scrollTop;
				}
				pill.style.width = `${String(item.offsetWidth)}px`;
				pill.style.height = `${String(item.offsetHeight)}px`;
				const target = { x, y };
				pill.style.background =
					item.dataset.variant === "destructive"
						? "color-mix(in srgb, var(--color-danger) 10%, transparent)"
						: "var(--color-surface-hover)";
				pillAnimation?.stop();
				if (!visible || instant) {
					visible = true;
					// Through `animate` (duration 0) rather than inline styles, so motion's tracked
					// x/y start from here on the next glide instead of from zero.
					animate(pill, target, { duration: 0 });
					pillAnimation = animate(pill, { opacity: 1 }, { duration: 0.12 });
					return;
				}
				// 140ms follows keyboard navigation without trailing behind the next key press.
				pillAnimation = animate(pill, { ...target, opacity: 1 }, { duration: 0.14, ease: EASE_OUT });
			};
			const resize = new ResizeObserver(() => {
				if (focused && visible) moveTo(focused, true);
			});
			resize.observe(host);
			const hide = () => {
				if (focused) resize.unobserve(focused);
				focused = null;
				visible = false;
				pillAnimation?.stop();
				pillAnimation = animate(pill, { opacity: 0 }, { duration: 0.12 });
			};
			const onFocusIn = (event: FocusEvent) => {
				const item = event.target instanceof Element ? event.target.closest(ITEM_SELECTOR) : null;
				if (item instanceof HTMLElement && host.contains(item)) moveTo(item);
			};
			const onFocusOut = (event: FocusEvent) => {
				const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest(ITEM_SELECTOR) : null;
				if (!next || !host.contains(next)) hide();
			};
			content.addEventListener("focusin", onFocusIn);
			content.addEventListener("focusout", onFocusOut);
			const root = content.getRootNode();
			const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
			if (active instanceof HTMLElement && host.contains(active) && active.matches(ITEM_SELECTOR)) moveTo(active, true);
			return () => {
				content.removeEventListener("focusin", onFocusIn);
				content.removeEventListener("focusout", onFocusOut);
				resize.disconnect();
				pillAnimation?.stop();
				pill.remove();
				if (needsPosition) host.style.position = originalPosition;
				delete content.dataset.menuGlide;
			};
		},
		[reducedMotion, skinMotion],
	);
}
