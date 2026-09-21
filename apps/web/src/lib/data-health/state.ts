import type { DataStoreHealth } from "@ling/contracts/data-store";
import { atom, useSetAtom } from "jotai";
import { useEffect } from "react";

export interface DataRecoveryAction {
	label: string;
	description: string;
	run(): Promise<unknown>;
}
interface DataIssue {
	label: string;
	message: string;
	retry?(): Promise<unknown>;
	recovery?: DataRecoveryAction;
	action?: { label: string; run(): Promise<unknown> };
}
export const dataIssuesAtom = atom<Record<string, DataIssue>>({});
export const dataHealthAtom = atom<DataStoreHealth | null>(null);
export const dataHealthErrorAtom = atom<string | null>(null);
export const dataHealthOpenAtom = atom(false);
export const dataHealthActionsAtom = atom<{ refresh(): Promise<void>; retry(): Promise<void> } | null>(null);
/** A domain retains its failure and recovery behavior while the application exposes one shared entry point. */
export function useDataIssue(key: string, issue: DataIssue | null) {
	const setIssues = useSetAtom(dataIssuesAtom);
	useEffect(() => {
		setIssues((current) => {
			if (issue === null && !Object.hasOwn(current, key)) return current;
			const next = { ...current };
			if (issue) next[key] = issue;
			else delete next[key];
			return next;
		});
		return () =>
			setIssues((current) => {
				if (current[key] !== issue) return current;
				const next = { ...current };
				delete next[key];
				return next;
			});
	}, [key, issue, setIssues]);
}
