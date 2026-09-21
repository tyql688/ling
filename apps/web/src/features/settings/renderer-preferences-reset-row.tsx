import { errorMessage } from "@ling/contracts/ling-error";
import { Button } from "@renderer/components/ui/button";
import { SettingsRow } from "@renderer/components/ui/settings-list";
import {
	getRendererPreferenceDiagnostics,
	resetRendererPreferences,
} from "@renderer/lib/preferences/renderer-preferences";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type ResetState = "idle" | "confirming" | "reset" | "error";

export function RendererPreferencesResetRow() {
	const { t } = useTranslation();
	const [state, setState] = useState<ResetState>("idle");
	const [error, setError] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState(() => getRendererPreferenceDiagnostics());

	const reset = () => {
		try {
			resetRendererPreferences();
			setDiagnostics([]);
			setError(null);
			setState("reset");
		} catch (resetError) {
			setError(errorMessage(resetError));
			setState("error");
		}
	};

	const description = (() => {
		if (error !== null) return t("settings.rendererPreferencesResetError", { message: error });
		if (state === "confirming") return t("settings.rendererPreferencesResetConfirmDescription");
		if (state === "reset") return t("settings.rendererPreferencesResetDone");
		if (diagnostics.length > 0) {
			return t("settings.rendererPreferencesRepairDescription", {
				message: diagnostics.map((diagnostic) => `${diagnostic.key}: ${diagnostic.message}`).join("; "),
			});
		}
		return t("settings.rendererPreferencesResetDescription");
	})();

	return (
		<SettingsRow label={t("settings.rendererPreferencesReset")} description={description}>
			{state === "confirming" ? (
				<>
					<Button variant="ghost" size="sm" onClick={() => setState("idle")}>
						{t("settings.rendererPreferencesResetCancel")}
					</Button>
					<Button variant="outline" size="sm" onClick={reset}>
						{t("settings.rendererPreferencesResetConfirm")}
					</Button>
				</>
			) : (
				<Button variant="outline" size="sm" onClick={() => setState("confirming")}>
					{diagnostics.length > 0
						? t("settings.rendererPreferencesRepairAction")
						: t("settings.rendererPreferencesResetAction")}
				</Button>
			)}
		</SettingsRow>
	);
}
