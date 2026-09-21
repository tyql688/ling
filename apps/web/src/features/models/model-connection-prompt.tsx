import { Button } from "@renderer/components/ui/button";
import { EmptyState } from "@renderer/components/ui/empty-state";
import { appModeAtom, settingsCategoryAtom } from "@renderer/lib/navigation-state";
import { useSetAtom } from "jotai";
import { Plug } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Only an authoritative empty usable catalog reaches this setup prompt. */
export function ModelConnectionPrompt({ compact = false }: { compact?: boolean }) {
	const { t } = useTranslation();
	const setMode = useSetAtom(appModeAtom);
	const setCategory = useSetAtom(settingsCategoryAtom);
	const action = (
		<Button
			size={compact ? "sm" : "default"}
			onClick={() => {
				setCategory("models");
				setMode("settings");
			}}
		>
			{t("session.connectModel")}
		</Button>
	);
	if (compact)
		return (
			<div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
				<p className="text-xs text-text-muted">{t("session.connectModelDescription")}</p>
				{action}
			</div>
		);
	return (
		<EmptyState
			variant="first-run"
			icon={Plug}
			title={t("session.connectModelTitle")}
			description={t("session.connectModelDescription")}
			action={action}
		/>
	);
}
