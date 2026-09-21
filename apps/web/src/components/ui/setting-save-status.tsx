import { useTranslation } from "react-i18next";
import type { SettingSaveState } from "@renderer/hooks/use-setting-draft";

export function SettingSaveStatus({ state, retry }: { state: SettingSaveState; retry(): void }) {
	const { t } = useTranslation();
	return (
		<span className="inline-flex min-w-16 items-center gap-2 text-xs text-text-muted" role="status">
			{state.status === "saving" && t("settings.saving")}
			{state.status === "saved" && t("settings.saved")}
			{state.status === "failed" && (
				<>
					<span className="text-danger" title={state.error ?? undefined}>
						{t("settings.saveFailed")}
					</span>
					<button type="button" onClick={retry} className="underline underline-offset-2">
						{t("common.retry")}
					</button>
				</>
			)}
		</span>
	);
}
