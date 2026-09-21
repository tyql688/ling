import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRef } from "react";

/** Command-menu selection/navigation keys: during composition they belong to the IME, preventing accidental submit or selection. */
const COMMAND_MENU_KEYS = new Set(["Enter", "Escape", "ArrowUp", "ArrowDown", "Home", "End"]);
/** cmdk vim-style Ctrl+n/j/p/k; likewise suppressed during composition. */
const COMMAND_MENU_VIM_KEYS = new Set(["n", "j", "p", "k"]);

/** Keys cmdk consumes as selection/navigation commands. During composition
 * these stay with the IME; ordinary character keydowns must retain their
 * default input behavior. */
export function isImeCommandMenuKey(event: Pick<globalThis.KeyboardEvent, "key" | "ctrlKey">): boolean {
	return COMMAND_MENU_KEYS.has(event.key) || (event.ctrlKey && COMMAND_MENU_VIM_KEYS.has(event.key));
}

interface ImeCompositionTracker {
	start(): void;
	end(): void;
	reset(): void;
	isComposing(event: Pick<globalThis.KeyboardEvent, "isComposing" | "keyCode">): boolean;
}

/** Stateful core kept separate from React so close/reopen boundaries can be tested.
 * `reset()` is required when a conditional input disappears before compositionend. */
function createImeCompositionTracker(): ImeCompositionTracker {
	let tracked = false;
	return {
		start() {
			tracked = true;
		},
		end() {
			tracked = false;
		},
		reset() {
			tracked = false;
		},
		isComposing(event) {
			// keyCode 229 is the browser's legacy marker for "IME composition in progress"; fallback when isComposing is missing
			// eslint-disable-next-line @typescript-eslint/no-deprecated -- keyCode is deprecated but still the only signal some IMEs emit; dropping it would submit the field mid-composition
			return tracked || event.isComposing || event.keyCode === 229;
		},
	};
}

/**
 * IME composition guard: pressing Enter to confirm a pinyin/kana/hangul composition must
 * operate the IME, never submit the field.
 *
 * Belt and braces on purpose — a ref tracks composition via events AND the check consults the
 * native `isComposing`/keyCode-229 flags, because some IME/engine combinations fire
 * `compositionend` before the confirming keydown arrives.
 */
export function useImeGuard() {
	const trackerRef = useRef<ImeCompositionTracker | null>(null);
	if (trackerRef.current === null) trackerRef.current = createImeCompositionTracker();
	const guardRef = useRef<{
		compositionProps: { onCompositionStart: () => void; onCompositionEnd: () => void };
		isComposing: (event: ReactKeyboardEvent<Element>) => boolean;
		isNativeComposing: (event: Pick<globalThis.KeyboardEvent, "isComposing" | "keyCode">) => boolean;
		resetComposition: () => void;
	} | null>(null);
	if (guardRef.current === null) {
		const tracker = trackerRef.current;
		guardRef.current = {
			/** Spread onto the input/textarea. */
			compositionProps: {
				onCompositionStart: tracker.start,
				onCompositionEnd: tracker.end,
			},
			/** True while the key event belongs to an active IME composition. */
			isComposing: (event: ReactKeyboardEvent<Element>): boolean => tracker.isComposing(event.nativeEvent),
			/** Native-event equivalent for capture-phase primitives such as Radix dismissable layers. */
			isNativeComposing: tracker.isComposing,
			/** Clear tracked state when an input closes before its compositionend event arrives. */
			resetComposition: tracker.reset,
		};
	}
	return guardRef.current;
}
