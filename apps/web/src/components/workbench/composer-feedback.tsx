import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const ComposerFeedbackTarget = createContext<HTMLDivElement | null>(null);

/** Toolbar features keep their feedback in the owning composer's flow, above its editor. */
export function ComposerFeedbackArea({ children }: { children: ReactNode }) {
	const [target, setTarget] = useState<HTMLDivElement | null>(null);
	return (
		<ComposerFeedbackTarget.Provider value={target}>
			<div ref={setTarget} className="flex min-w-0 flex-col gap-2 empty:hidden" />
			{children}
		</ComposerFeedbackTarget.Provider>
	);
}

export function ComposerFeedback({ children }: { children: ReactNode }) {
	const target = useContext(ComposerFeedbackTarget);
	return target ? createPortal(children, target) : null;
}
