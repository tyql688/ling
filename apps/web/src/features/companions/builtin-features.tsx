import type { BuiltinFeatureId } from "@ling/contracts/builtin-features";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useAppNavigation } from "@renderer/lib/app-navigation";
import { BuiltinFeaturesContext, useBuiltinFeatures, useFeatureSettings } from "./builtin-feature-state";

/** One switch snapshot follows Host events across every feature and both settings/workspace views. */
export function BuiltinFeaturesProvider({ children }: { children: ReactNode }) {
	const state = useFeatureSettings();
	return <BuiltinFeaturesContext value={state}>{children}</BuiltinFeaturesContext>;
}

/** Disabled features keep their history and cleanup controls reachable. */
export function BuiltinFeatureNotice({ id }: { id: BuiltinFeatureId }) {
	const { t } = useTranslation();
	const state = useBuiltinFeatures();
	const navigation = useAppNavigation();
	if (state.error) return <FeedbackNotice tone="danger">{state.error}</FeedbackNotice>;
	if (!state.value || state.value.enabled[id]) return null;
	return (
		<FeedbackNotice
			action={
				<Button variant="ghost" size="sm" onClick={() => navigation.openSettings("plugins")}>
					{t("builtinFeatures.manage")}
				</Button>
			}
		>
			{t(id === "permissions" ? "builtinFeatures.permissionsDisabled" : "builtinFeatures.disabled")}
		</FeedbackNotice>
	);
}
