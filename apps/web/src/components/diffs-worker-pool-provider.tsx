import { errorMessage } from "@ling/contracts/ling-error";
import { useWorkerPool, type WorkerInitializationRenderOptions, WorkerPoolContextProvider } from "@pierre/diffs/react";
import diffsWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { CODE_THEME_PAIRS } from "@renderer/lib/preferences/code-preview";
import { useAtomValue } from "jotai";
import { type ReactNode, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

type DiffsWorkerRenderOptions = Required<
	Pick<
		WorkerInitializationRenderOptions,
		"lineDiffType" | "maxLineDiffLength" | "theme" | "tokenizeMaxLineLength" | "useTokenTransformer"
	>
>;

const BASE_HIGHLIGHTER_OPTIONS = {
	lineDiffType: "word-alt",
	maxLineDiffLength: 1_000,
	tokenizeMaxLineLength: 1_000,
	useTokenTransformer: false,
} as const;

function createDiffsWorker(): Worker {
	return new Worker(diffsWorkerUrl, { type: "module", name: "ling-diffs-worker" });
}

function DiffsWorkerOptionsSync({ options }: { options: DiffsWorkerRenderOptions }) {
	const pool = useWorkerPool();
	const { show: showFeedback } = useAppFeedback();
	const { t } = useTranslation();

	useEffect(() => {
		if (!pool) return;
		let active = true;
		void pool.setRenderOptions(options).catch((error: unknown) => {
			// A theme switch or provider replacement can retire this request while it is in flight.
			// Only the currently authoritative synchronization may surface a failure.
			if (!active) return;
			showFeedback({
				tone: "danger",
				title: t("errorBoundary.globalErrorTitle"),
				description: errorMessage(error),
				dedupeKey: "diff-worker-options-sync",
			});
		});
		return () => {
			active = false;
		};
	}, [options, pool, showFeedback, t]);

	return null;
}

export function DiffsWorkerPoolProvider({ children }: { children: ReactNode }) {
	const activeAppearance = useAtomValue(activeSkinAppearanceAtom);
	const options: DiffsWorkerRenderOptions = useMemo(
		() => ({ ...BASE_HIGHLIGHTER_OPTIONS, theme: CODE_THEME_PAIRS[activeAppearance.codeTheme] }),
		[activeAppearance.codeTheme],
	);
	if (typeof Worker === "undefined") return children;

	return (
		<WorkerPoolContextProvider
			// Pierre shares one worker across mounted code views and releases it after the last view closes.
			poolOptions={{ workerFactory: createDiffsWorker, poolSize: 1 }}
			highlighterOptions={options}
		>
			<DiffsWorkerOptionsSync options={options} />
			{children}
		</WorkerPoolContextProvider>
	);
}
