import { accessChoice, type AccessChoice } from "@ling/contracts/permissions";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAccessActivation } from "./use-access-activation";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";
import { Button } from "@renderer/components/ui/button";
import { useAppNavigation } from "@renderer/lib/app-navigation";

const choices: AccessChoice[] = ["full", "global", "project"];

/** Composer switch between full access and the permission system for the current project. */
export function AccessModeControl({ cwd }: { cwd: string }) {
	const { t } = useTranslation();
	const api = useDomainApi("permissions");
	const state = useAccessActivation();
	const features = useBuiltinFeatures();
	const navigation = useAppNavigation();
	const [pending, setPending] = useState<AccessChoice | null>(null);
	if (features.value && !features.value.enabled.permissions)
		return (
			<Button
				variant="ghost"
				size="sm"
				className="h-7 gap-1 px-1.5 text-xs font-normal"
				onClick={() => navigation.openSettings("plugins")}
			>
				<ShieldCheck className="size-3.5" aria-hidden="true" />
				{t("builtinFeatures.permissionsOff")}
			</Button>
		);
	if (!state.value)
		return state.error ? (
			<FeedbackNotice tone="danger" className="text-xs">
				{state.error}
			</FeedbackNotice>
		) : null;
	const current = pending ?? accessChoice(state.value, cwd);
	const revision = state.value.revision;
	return (
		<>
			<Select
				value={current}
				disabled={state.busy}
				onValueChange={(value) => {
					const next = value as AccessChoice;
					setPending(next);
					void state
						.act(() =>
							api.write({
								expectedRevision: revision,
								...(next === "global" ? { defaultEnabled: true } : {}),
								project: { cwd, enabled: next === "global" ? null : next === "project" },
							}),
						)
						.finally(() => setPending(null));
				}}
			>
				<SelectTrigger
					size="sm"
					variant="ghost"
					aria-label={t("permissions.accessMode")}
					title={t("permissions.accessMode")}
					className="h-7 shrink-0 gap-1 px-1.5 text-xs font-normal"
				>
					<ShieldCheck className="size-3.5" aria-hidden="true" />
					<SelectValue>{t(`permissions.choice.${current}`)}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{choices.map((choice) => (
						<SelectItem key={choice} value={choice}>
							{t(`permissions.choice.${choice}`)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{state.error && (
				<FeedbackNotice tone="danger" className="text-xs">
					{state.error}
				</FeedbackNotice>
			)}
		</>
	);
}
