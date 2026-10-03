import { accessChoice, type AccessChoice, type PermissionSource } from "@ling/contracts/permissions";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { sessionPermissionSourceFamily } from "@renderer/features/sessions/state/session";
import { useAtomValue } from "jotai";
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
export function SessionAccessModeControl({ sessionRef }: { sessionRef: SessionRef }) {
	const source = useAtomValue(sessionPermissionSourceFamily(sessionKey(sessionRef)));
	return <AccessModeControl cwd={sessionRef.cwd} source={source} />;
}

export function AccessModeControl({ cwd, source }: { cwd: string; source?: PermissionSource | null }) {
	const { t } = useTranslation();
	const api = useDomainApi("permissions");
	const state = useAccessActivation();
	const features = useBuiltinFeatures();
	const navigation = useAppNavigation();
	const [pending, setPending] = useState<AccessChoice | null>(null);
	if (source === "external")
		return (
			<Button
				variant="ghost"
				size="sm"
				className="h-7 gap-1 px-1.5 text-xs font-normal"
				title={t("permissions.externalDescription")}
				onClick={() => navigation.openSettings("plugins")}
			>
				<ShieldCheck className="size-3.5" aria-hidden="true" />
				{t("permissions.external")}
			</Button>
		);
	if (source === null) return null;
	if (features.value && !features.value.enabled.permissions && source !== "bundled")
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
	const waitingForReload =
		source !== undefined &&
		(source === "bundled") !== (current !== "full" && features.value?.enabled.permissions === true);
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
					<SelectValue>{waitingForReload ? t("permissions.applying") : t(`permissions.choice.${current}`)}</SelectValue>
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
