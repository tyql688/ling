import type { ExtensionUiRequest } from "@ling/contracts/session";
import { Button } from "@renderer/components/ui/button";
import { InteractionCard, InteractionChoice } from "@renderer/components/ui/interaction-card";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { FormField } from "@renderer/components/ui/form-field";
import { formatRequestError } from "@renderer/lib/errors";
import { Clock3, Puzzle } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TerminalText } from "./terminal-text";
import { projectExtensionTerminalText } from "./extension-terminal-text";
import { useRemainingSeconds } from "./use-remaining-seconds";

interface ExtensionUiPromptCardProps {
	request: ExtensionUiRequest;
	pendingCount: number;
	onRespond: (value: string | null) => Promise<void>;
}

function indexedOptions(options: string[]): { id: string; value: string }[] {
	const occurrences = new Map<string, number>();
	return options.map((value) => {
		const occurrence = occurrences.get(value) ?? 0;
		occurrences.set(value, occurrence + 1);
		return { id: `${value}:${occurrence}`, value };
	});
}

export function ExtensionUiPromptCard({ request, pendingCount, onRespond }: ExtensionUiPromptCardProps) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState(request.initialValue ?? "");
	const [responding, setResponding] = useState(false);
	const submitting = useRef(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const remainingSeconds = useRemainingSeconds(request.expiresAt);
	const [rawHeadline = "", ...detailLines] = request.title.split("\n");
	const headline = rawHeadline.trim() === "" ? t("extensionUi.requestLabel") : rawHeadline;
	const options = indexedOptions(request.options);

	const respond = useCallback(
		async (value: string | null) => {
			// Mouse double-click and keyboard activation can arrive before React commits disabled controls.
			if (submitting.current) return false;
			submitting.current = true;
			setResponding(true);
			setError(null);
			try {
				await onRespond(value);
				return true;
			} catch (cause) {
				submitting.current = false;
				setError(formatRequestError(cause));
				setResponding(false);
				return false;
			}
		},
		[onRespond],
	);

	return (
		<InteractionCard
			label={t("extensionUi.requestLabel")}
			title={<TerminalText value={headline} />}
			icon={<Puzzle className="size-4" />}
			meta={pendingCount > 1 ? t("extensionUi.pendingCount", { count: pendingCount }) : undefined}
			hint={
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					{request.kind === "select" && <p>{t("extensionUi.selectConfirmHint")}</p>}
					{remainingSeconds !== null && (
						<span className="inline-flex items-center gap-1 tabular-nums">
							<Clock3 className="size-3.5" aria-hidden="true" />
							{t("extensionUi.expiresIn", { count: remainingSeconds })}
						</span>
					)}
				</div>
			}
			footer={
				<>
					<Button variant="ghost" size="sm" disabled={responding} onClick={() => void respond(null)}>
						{t("extensionUi.cancel")}
					</Button>
					<Button
						size="sm"
						disabled={responding || (request.kind === "select" && selected === null)}
						onClick={() => {
							if (request.kind !== "select") void respond(draft);
							else {
								const option = options.find((item) => item.id === selected);
								if (option) void respond(option.value);
							}
						}}
					>
						{t(request.kind === "select" ? "extensionUi.confirmSelection" : "extensionUi.submit")}
					</Button>
				</>
			}
		>
			{detailLines.length > 0 && (
				<pre className="attention-prompt-card-detail min-w-0 whitespace-pre-wrap rounded-control px-3 py-2 font-mono text-xs leading-relaxed text-text-primary [overflow-wrap:anywhere]">
					<TerminalText value={detailLines.join("\n")} />
				</pre>
			)}
			{request.kind === "select" ? (
				<div className="grid gap-1.5" role="radiogroup" aria-label={headline}>
					{options.map((option, index) => (
						<InteractionChoice
							key={option.id}
							name={request.requestId}
							value={option.id}
							// eslint-disable-next-line jsx-a11y/no-autofocus -- Pi is waiting on this prompt; focus its first response control.
							autoFocus={index === 0}
							disabled={responding}
							selected={selected === option.id}
							onSelect={() => setSelected(option.id)}
							onConfirm={() => void respond(option.value)}
						>
							<TerminalText value={option.value} />
						</InteractionChoice>
					))}
				</div>
			) : request.kind === "editor" ? (
				<FormField label={t("interactions.yourAnswer")}>
					<Textarea
						aria-label={headline}
						// eslint-disable-next-line jsx-a11y/no-autofocus -- Pi is waiting on this prompt; focus its text field.
						autoFocus
						value={draft}
						disabled={responding}
						onChange={(event) => setDraft(event.target.value)}
						className="max-h-52 min-h-24 resize-y bg-input text-ui leading-relaxed [field-sizing:content]"
					/>
				</FormField>
			) : (
				<FormField label={t("interactions.yourAnswer")}>
					<Input
						aria-label={headline}
						// eslint-disable-next-line jsx-a11y/no-autofocus -- Pi is waiting on this prompt; focus its text field.
						autoFocus
						value={draft}
						disabled={responding}
						placeholder={projectExtensionTerminalText(request.placeholder ?? "")}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.nativeEvent.isComposing) void respond(draft);
						}}
					/>
				</FormField>
			)}
			{error !== null && (
				<FeedbackNotice tone="danger" className="text-xs">
					<span className="break-words">{error}</span>
				</FeedbackNotice>
			)}
		</InteractionCard>
	);
}
