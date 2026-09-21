import { useSyncExternalStore } from "react";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function subscribe(onChange: () => void): () => void {
	reducedMotion.addEventListener("change", onChange);
	return () => reducedMotion.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
	return reducedMotion.matches;
}

/** Keep mounted surfaces in sync when the system motion preference changes. */
export function useReducedMotion(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}
