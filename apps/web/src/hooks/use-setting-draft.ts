import { formatRequestError } from "@renderer/lib/errors";
import { useEffect, useRef, useState } from "react";

export type SettingSaveState = { status: "idle" | "saving" | "saved" } | { status: "failed"; error: string | null };

/** Keeps an unsaved edit through refreshes and admits one write until its result arrives. */
export function useSettingDraft(
	value: string,
	save: (draft: string) => Promise<boolean>,
	valid: (draft: string) => boolean = () => true,
) {
	const [draft, setDraft] = useState(value);
	const [state, setState] = useState<SettingSaveState>({ status: "idle" });
	const previous = useRef(value);
	const submitted = useRef<string | null>(null);
	const mounted = useRef(true);
	const pending = useRef(false);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	useEffect(() => {
		const before = previous.current;
		previous.current = value;
		setDraft((current) => (current === before || current === submitted.current ? value : current));
	}, [value]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const commit = async () => {
		const next = draftRef.current;
		if (pending.current || !valid(next) || (next === value && state.status !== "failed")) return;
		pending.current = true;
		submitted.current = next;
		setState({ status: "saving" });
		try {
			const saved = await save(next);
			if (mounted.current) setState(saved ? { status: "saved" } : { status: "failed", error: null });
		} catch (error) {
			if (mounted.current) setState({ status: "failed", error: formatRequestError(error) });
		} finally {
			pending.current = false;
		}
	};
	return {
		draft,
		state,
		valid: valid(draft),
		change(next: string) {
			submitted.current = null;
			draftRef.current = next;
			setDraft(next);
			setState({ status: "idle" });
		},
		reset() {
			submitted.current = null;
			draftRef.current = value;
			setDraft(value);
			setState({ status: "idle" });
		},
		commit,
	};
}
