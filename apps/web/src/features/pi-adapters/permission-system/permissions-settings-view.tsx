import type { OpenProjectInfo } from "@ling/contracts/project";
import { BuiltinFeatureNotice } from "@renderer/features/companions/builtin-features";
import { BuiltinFeatureDocumentation } from "@renderer/features/companions/builtin-feature-documentation";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { useAppNavigation } from "@renderer/lib/app-navigation";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { Folder, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAccessActivation } from "./use-access-activation";

function RulesFileAction({ cwd, desktop, available }: { cwd: string | null; desktop: boolean; available: boolean }) {
	const { t } = useTranslation();
	const api = useDomainApi("permissions");
	const navigation = useAppNavigation();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const opening = useRef(false);
	const open = async () => {
		if (opening.current) return;
		opening.current = true;
		setBusy(true);
		setError(null);
		try {
			await navigation.openPath(await api.prepareRulesFile(cwd));
		} catch (failure) {
			setError(formatRequestError(failure));
		} finally {
			opening.current = false;
			setBusy(false);
		}
	};
	return (
		<SettingsRow
			label={t(cwd ? "permissions.projectRules" : "permissions.globalRules")}
			description={t(
				!desktop
					? "permissions.rulesDesktopOnly"
					: available
						? "permissions.rulesDescription"
						: "permissions.projectUnavailable",
			)}
		>
			<div className="flex flex-col items-end gap-2">
				<Button variant="outline" size="sm" disabled={!desktop || !available || busy} onClick={() => void open()}>
					<Pencil className="size-3.5" aria-hidden="true" />
					{t(busy ? "permissions.opening" : "permissions.editRules")}
				</Button>
				{error && (
					<FeedbackNotice tone="danger" className="text-xs">
						{error}
					</FeedbackNotice>
				)}
			</div>
		</SettingsRow>
	);
}

export function PermissionsSettingsView({
	projects,
	activeCwd,
	nativePathOpen,
}: {
	projects: OpenProjectInfo[];
	activeCwd: string | null;
	nativePathOpen: boolean;
}) {
	const { t } = useTranslation();
	const api = useDomainApi("permissions");
	const state = useAccessActivation();
	const value = state.value;
	const [selectedCwd, setSelectedCwd] = useState(activeCwd);
	// This selection only chooses what is edited here; it never navigates the workspace.
	const selected =
		projects.find((item) => item.cwd === selectedCwd) ?? projects.find((item) => item.cwd === activeCwd) ?? projects[0];
	const project = selected ? value?.projects[selected.cwd] : undefined;
	const [pending, setPending] = useState<{ target: string; value: string } | null>(null);
	const save = (target: "global" | "project", enabled: boolean | null) => {
		if (!value || (target === "project" && !selected)) return;
		setPending({
			target: target === "global" ? "global" : selected!.cwd,
			value: enabled === null ? "default" : enabled ? "approval" : "full",
		});
		void state
			.act(() =>
				api.write(
					target === "global"
						? { expectedRevision: value.revision, defaultEnabled: enabled === true }
						: { expectedRevision: value.revision, project: { cwd: selected!.cwd, enabled } },
				),
			)
			.finally(() => setPending(null));
	};
	const availability = (item: OpenProjectInfo) => item.availability ?? "ready";
	return (
		<SettingsPage
			title={t("permissions.title")}
			description={t("permissions.description")}
			actions={<BuiltinFeatureDocumentation id="permissions" label={t("permissions.title")} />}
		>
			<BuiltinFeatureNotice id="permissions" />
			{state.error && (
				<FeedbackNotice
					tone="danger"
					action={
						<Button variant="ghost" size="sm" onClick={() => void state.refresh()}>
							{t("permissions.refresh")}
						</Button>
					}
				>
					{state.error}
				</FeedbackNotice>
			)}
			{value && (
				<>
					<SettingsSection title={t("permissions.accessMode")}>
						<SettingsRow label={t("permissions.globalDefault")} description={t("permissions.globalDefaultDescription")}>
							<Select
								value={pending?.target === "global" ? pending.value : value.defaultEnabled ? "approval" : "full"}
								disabled={state.busy}
								onValueChange={(input) => save("global", input === "approval")}
							>
								<SelectTrigger aria-label={t("permissions.globalDefault")}>
									<SelectValue>
										{t(
											(pending?.target === "global" ? pending.value : value.defaultEnabled ? "approval" : "full") ===
												"approval"
												? "permissions.approval"
												: "permissions.choice.full",
										)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="full">{t("permissions.choice.full")}</SelectItem>
									<SelectItem value="approval">{t("permissions.approval")}</SelectItem>
								</SelectContent>
							</Select>
						</SettingsRow>
						<RulesFileAction cwd={null} desktop={nativePathOpen} available />
					</SettingsSection>
					<SettingsSection title={t("permissions.projectSection")}>
						{selected ? (
							<>
								<SettingsRow label={t("permissions.project")} description={selected.cwd}>
									<Select value={selected.cwd} onValueChange={setSelectedCwd}>
										<SelectTrigger aria-label={t("permissions.chooseProject")} className="max-w-64">
											<Folder className="size-4" aria-hidden="true" />
											<SelectValue>{selected.name}</SelectValue>
										</SelectTrigger>
										<SelectContent>
											{projects.map((item) => (
												<SelectItem key={item.cwd} value={item.cwd}>
													{projects.some((other) => other.cwd !== item.cwd && other.name === item.name)
														? `${item.name} · ${item.cwd}`
														: item.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingsRow>
								<SettingsRow
									label={t("permissions.accessMode")}
									description={t(
										availability(selected) === "missing"
											? "permissions.projectUnavailable"
											: "permissions.projectChoiceDescription",
									)}
								>
									<Select
										value={
											pending?.target === selected.cwd
												? pending.value
												: project === undefined
													? "default"
													: project
														? "approval"
														: "full"
										}
										disabled={state.busy || availability(selected) === "missing"}
										onValueChange={(input) => save("project", input === "default" ? null : input === "approval")}
									>
										<SelectTrigger aria-label={t("permissions.projectAccess")}>
											<SelectValue>
												{(() => {
													const current =
														pending?.target === selected.cwd
															? pending.value
															: project === undefined
																? "default"
																: project
																	? "approval"
																	: "full";
													return current === "default"
														? `${t("permissions.useGlobalDefault")} · ${t(value.defaultEnabled ? "permissions.approval" : "permissions.choice.full")}`
														: t(current === "approval" ? "permissions.approval" : "permissions.choice.full");
												})()}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="default">
												{t("permissions.useGlobalDefault")} ·{" "}
												{t(value.defaultEnabled ? "permissions.approval" : "permissions.choice.full")}
											</SelectItem>
											<SelectItem value="full">{t("permissions.choice.full")}</SelectItem>
											<SelectItem value="approval">{t("permissions.approval")}</SelectItem>
										</SelectContent>
									</Select>
								</SettingsRow>
								<RulesFileAction
									key={selected.cwd}
									cwd={selected.cwd}
									desktop={nativePathOpen}
									available={availability(selected) === "ready"}
								/>
							</>
						) : (
							<SettingsRow label={t("permissions.noProjects")} description={t("permissions.noProjectsDescription")}>
								<span />
							</SettingsRow>
						)}
					</SettingsSection>
					<div className="flex flex-col gap-2 px-1 text-xs leading-relaxed text-text-muted">
						<p role="status">{t(state.busy ? "permissions.applying" : "permissions.precedence")}</p>
						<p>{t("permissions.fullAccessNote")}</p>
						<p>{t("permissions.approvalNote")}</p>
					</div>
				</>
			)}
		</SettingsPage>
	);
}
