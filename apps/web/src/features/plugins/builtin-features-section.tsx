import { builtinFeatureIdSchema } from "@ling/contracts/builtin-features";
import { ResourceReloadFeedback } from "@renderer/components/resource-reload-feedback";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { Switch } from "@renderer/components/ui/switch";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { VoiceSettings } from "@renderer/features/pi-adapters/voice/voice-settings";
import { voiceShortcut } from "@renderer/features/pi-adapters/voice/voice-shortcuts";

const titles = {
	todo: "todo.title",
	permissions: "permissions.title",
	questions: "questions.title",
	"background-tasks": "backgroundTasks.title",
	schedules: "schedules.title",
	voice: "voice.title",
} as const;

export function BuiltinFeaturesSection({ projectCwd }: { projectCwd: string | null }) {
	const { t } = useTranslation();
	const state = useBuiltinFeatures();
	const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
	return (
		<>
			<SettingsSection title={t("builtinFeatures.title")} description={t("builtinFeatures.description")}>
				{state.error && (
					<FeedbackNotice
						tone="danger"
						action={
							<Button variant="ghost" size="sm" onClick={() => void state.refresh()}>
								{t("plugins.retry")}
							</Button>
						}
					>
						{state.error}
					</FeedbackNotice>
				)}
				{state.value
					? builtinFeatureIdSchema.options.map((id) => (
							<SettingsRow
								key={id}
								label={t(titles[id])}
								description={t(`builtinFeatures.${id}`, { shortcut: voiceShortcut })}
								layout="toggle"
							>
								{id === "voice" && state.value!.enabled.voice && (
									<Button
										variant="ghost"
										size="sm"
										disabled={projectCwd === null || state.busy}
										title={projectCwd === null ? t("voice.openProject") : undefined}
										onClick={() => setVoiceSettingsOpen(true)}
									>
										{t("voice.settings")}
									</Button>
								)}
								<Switch
									aria-label={t(titles[id])}
									checked={state.value!.enabled[id]}
									disabled={state.busy}
									onCheckedChange={(enabled) => state.setEnabled(id, enabled)}
								/>
							</SettingsRow>
						))
					: !state.error && (
							<p role="status" className="px-5 py-4 text-sm text-text-muted">
								{t("builtinFeatures.loading")}
							</p>
						)}
			</SettingsSection>
			{state.reload && <ResourceReloadFeedback summary={state.reload} />}
			{voiceSettingsOpen && projectCwd !== null && state.value?.enabled.voice && (
				<VoiceSettings key={projectCwd} cwd={projectCwd} onClose={() => setVoiceSettingsOpen(false)} />
			)}
		</>
	);
}
