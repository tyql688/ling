import type { Interaction, InteractionAnswer } from "@ling/contracts/companions";
import { errorMessage } from "@ling/contracts/ling-error";
import { InteractionMarkdown } from "@renderer/components/interaction-markdown";
import { Button } from "@renderer/components/ui/button";
import { FormField } from "@renderer/components/ui/form-field";
import { InteractionCard, InteractionChoice } from "@renderer/components/ui/interaction-card";
import { Textarea } from "@renderer/components/ui/textarea";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { isShortcutModifier } from "@renderer/lib/platform";
import { MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useInteractions } from "./interactions-context";

type Draft = InteractionAnswer["answers"];

export function InteractionForm({ request }: { request: Interaction }) {
	const { t } = useTranslation();
	const api = useDomainApi("interactions");
	const { drafts, updateDraft, clearDraft } = useInteractions();
	const draft =
		drafts[request.id] ?? request.questions.map((question) => ({ id: question.id, selected: [], text: "" }));
	const [busy, setBusy] = useState(false);
	const submitting = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [index, setIndex] = useState(0);
	const [approved, setApproved] = useState<boolean | null>(null);
	const [submission] = useState(() => crypto.randomUUID());
	const questionLabel = useId();
	const questionGroup = useRef<HTMLDivElement>(null);
	const previousIndex = useRef(index);
	useEffect(() => {
		if (previousIndex.current === index) return;
		previousIndex.current = index;
		questionGroup.current
			?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
				"input:checked, input:not(:disabled), textarea:not(:disabled)",
			)
			?.focus();
	}, [index]);
	const question = request.questions[index];
	const answer = draft.find((item) => item.id === question?.id);
	const hasAnswer = (value: Draft[number] | undefined) =>
		Boolean(value && (value.selected.length > 0 || value.text.trim()));
	const complete = draft.every(hasAnswer);
	function update(selected: string[], text: string) {
		const next = draft.map((item) => (item.id === question?.id ? { ...item, selected, text } : item));
		updateDraft(request.id, next);
		return next;
	}
	async function submit(value: InteractionAnswer) {
		if (submitting.current) return;
		submitting.current = true;
		setBusy(true);
		setError(null);
		try {
			await api.answer(request.id, submission, value);
			clearDraft(request.id);
		} catch (failure) {
			submitting.current = false;
			setError(errorMessage(failure));
			setBusy(false);
		}
	}
	function confirm(next: Draft) {
		if (index < request.questions.length - 1) setIndex(index + 1);
		else if (next.every(hasAnswer)) void submit({ status: "answered", answers: next });
	}
	function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
		if (
			isShortcutModifier(event) &&
			event.key === "Enter" &&
			!event.nativeEvent.isComposing &&
			request.kind === "questions" &&
			complete
		) {
			event.preventDefault();
			void submit({ status: "answered", answers: draft });
		}
	}
	return (
		<InteractionCard
			label={request.title}
			title={request.title}
			meta={request.questions.length > 1 ? `${index + 1} / ${request.questions.length}` : undefined}
			icon={
				request.kind === "approval" ? <ShieldCheck className="size-4" /> : <MessageCircleQuestion className="size-4" />
			}
			hint={question?.options?.length || request.kind === "approval" ? t("extensionUi.selectConfirmHint") : undefined}
			footer={
				request.kind === "questions" ? (
					<>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => void submit({ status: "skipped", answers: [] })}
						>
							{t("interactions.skip")}
						</Button>
						{index > 0 && (
							<Button size="sm" variant="outline" disabled={busy} onClick={() => setIndex(index - 1)}>
								{t("interactions.previous")}
							</Button>
						)}
						<Button
							size="sm"
							disabled={busy || (index < request.questions.length - 1 ? !hasAnswer(answer) : !complete)}
							onClick={() => confirm(draft)}
						>
							{t(index < request.questions.length - 1 ? "interactions.next" : "interactions.send")}
						</Button>
					</>
				) : (
					<>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => void submit({ status: "answered", answers: [], approved: false })}
						>
							{t("extensionUi.cancel")}
						</Button>
						<Button
							size="sm"
							disabled={busy || approved === null}
							onClick={() => approved !== null && void submit({ status: "answered", answers: [], approved })}
						>
							{t("extensionUi.confirmSelection")}
						</Button>
					</>
				)
			}
		>
			{request.body && <InteractionMarkdown text={request.body} />}
			{question && answer && (
				<div ref={questionGroup} role="group" aria-labelledby={questionLabel} className="min-w-0">
					<div id={questionLabel} className="mb-3">
						<InteractionMarkdown text={question.title} />
					</div>
					{Boolean(question.options?.length) && (
						<div className="mb-2 flex min-h-7 items-center justify-between gap-2 text-xs text-text-muted">
							<span>
								{t(question.multiple ? "interactions.multipleChoice" : "interactions.singleChoice")}
								{question.multiple && answer.selected.length > 0 && (
									<span className="ms-2 tabular-nums" role="status">
										{t("interactions.selectedCount", { count: answer.selected.length })}
									</span>
								)}
							</span>
							{answer.selected.length > 0 && (
								<Button size="sm" variant="ghost" disabled={busy} onClick={() => update([], answer.text)}>
									{t("interactions.clearSelection")}
								</Button>
							)}
						</div>
					)}
					<div
						className="grid gap-1.5"
						role={question.options?.length ? (question.multiple ? "group" : "radiogroup") : undefined}
						aria-labelledby={questionLabel}
					>
						{question.options?.map((option) => (
							<InteractionChoice
								key={option.id}
								name={questionLabel}
								value={option.id}
								multiple={question.multiple === true}
								description={option.description}
								selected={answer.selected.includes(option.id)}
								disabled={busy}
								onKeyDown={onKeyDown}
								onSelect={() =>
									update(
										question.multiple
											? answer.selected.includes(option.id)
												? answer.selected.filter((id) => id !== option.id)
												: [...answer.selected, option.id]
											: [option.id],
										answer.text,
									)
								}
								onConfirm={() =>
									confirm(
										update(
											question.multiple ? Array.from(new Set([...answer.selected, option.id])) : [option.id],
											answer.text,
										),
									)
								}
							>
								{option.label}
							</InteractionChoice>
						))}
					</div>
					<FormField
						className={question.options?.length ? "mt-4" : undefined}
						label={t(question.options?.length ? "interactions.additionalAnswer" : "interactions.yourAnswer")}
					>
						<Textarea
							onKeyDown={onKeyDown}
							className="max-h-44 min-h-20 resize-y bg-input text-ui leading-relaxed [field-sizing:content]"
							rows={2}
							placeholder={t(question.options?.length ? "interactions.additionalPlaceholder" : "interactions.custom")}
							value={answer.text}
							disabled={busy}
							maxLength={16_384}
							onChange={(event) => update(answer.selected, event.target.value)}
						/>
					</FormField>
				</div>
			)}
			{request.kind === "approval" && (
				<div className="grid gap-1.5" role="radiogroup" aria-label={request.title}>
					{[true, false].map((value) => (
						<InteractionChoice
							key={String(value)}
							name={questionLabel}
							value={String(value)}
							selected={approved === value}
							disabled={busy}
							onSelect={() => setApproved(value)}
							onConfirm={() => void submit({ status: "answered", answers: [], approved: value })}
						>
							{t(value ? "interactions.approve" : "interactions.reject")}
						</InteractionChoice>
					))}
				</div>
			)}
			{error && (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			)}
		</InteractionCard>
	);
}
