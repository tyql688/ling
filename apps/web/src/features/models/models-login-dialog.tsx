import { Button } from "@renderer/components/ui/button";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";

import { FeedbackNotice } from "@renderer/components/ui/feedback";

import { Input } from "@renderer/components/ui/input";

import { ProviderGlyph } from "@renderer/features/models/provider-glyph";

import { COPY_CHECK_CLASS } from "@renderer/hooks/use-copy-feedback";

import { Check, Copy, ExternalLink, Eye, EyeOff } from "lucide-react";

import { useModelLogin, type ModelsLoginDialogProps } from "./use-model-login";

export function ModelsLoginDialog(props: ModelsLoginDialogProps) {
	const {
		handleClose,
		provider,
		t,
		loginMethod,
		flow,
		openExternal,
		respondingRequestId,
		respond,
		copyUrl,
		copiedUrl,
		activeInput,
		activeInputLabelId,
		showSecret,
		activeInputValue,
		revealingSecret,
		setInputDraft,
		setRevealedSecret,
		ime,
		canSubmit,
		inputDraft,
		revealedSecret,
		toggleSecretVisibility,
		responseError,
	} = useModelLogin(props);

	return (
		<Dialog open onOpenChange={(next) => !next && handleClose()}>
			<DialogContent className="overflow-y-auto">
				<div className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<ProviderGlyph provider={provider.id} size={18} />
							{t("models.loginTitle", { name: loginMethod ?? provider.displayName })}
						</DialogTitle>
					</DialogHeader>

					{flow.infos.map((info, index) => (
						<div
							// eslint-disable-next-line react/no-array-index-key -- provider info events append and never reorder.
							key={index}
							className="flex flex-col gap-2 rounded-control border border-border-subtle px-3 py-2.5"
						>
							<p className="text-sm text-text-primary">{info.message}</p>
							{info.links.map((link) => (
								<Button
									key={link.url}
									variant="ghost"
									size="sm"
									className="min-h-11 self-start sm:min-h-7"
									onClick={() => openExternal(link.url)}
								>
									<ExternalLink className="size-3.5" aria-hidden="true" />
									{link.label ?? link.url}
								</Button>
							))}
						</div>
					))}

					{flow.select && (
						<fieldset className="flex flex-col gap-2">
							<legend className="mb-2 text-sm text-text-primary">{flow.select.message}</legend>
							{flow.select.options.map((option) => (
								<Button
									key={option.id}
									variant="outline"
									size="sm"
									className="min-h-11 justify-start sm:min-h-7"
									disabled={respondingRequestId !== null}
									onClick={() => {
										if (flow.select) void respond(flow.select.requestId, option.id);
									}}
								>
									<span className="flex flex-col items-start">
										<span>{option.label}</span>
										{option.description && <span className="text-xs text-text-muted">{option.description}</span>}
									</span>
								</Button>
							))}
						</fieldset>
					)}

					{flow.deviceCode && (
						<div
							aria-live="polite"
							className="flex flex-col items-center gap-3 rounded-control border border-border-subtle px-4 py-4"
						>
							<div className="flex flex-col items-center gap-1.5">
								<span className="font-mono text-xl font-semibold tracking-widest text-text-primary">
									{flow.deviceCode.userCode}
								</span>
								<span className="text-center text-xs text-text-muted">{t("models.loginDeviceCodeHint")}</span>
							</div>
							<div className="flex flex-wrap items-center justify-center gap-2">
								<Button
									variant="outline"
									size="sm"
									className="min-h-11 whitespace-nowrap sm:min-h-7"
									onClick={() => {
										if (flow.deviceCode) void copyUrl(flow.deviceCode.verificationUri);
									}}
								>
									{copiedUrl === flow.deviceCode.verificationUri ? (
										<Check className={`size-3.5 ${COPY_CHECK_CLASS}`} aria-hidden="true" />
									) : (
										<Copy className="size-3.5" aria-hidden="true" />
									)}
									{t("models.loginCopyVerificationLink")}
								</Button>
								<Button
									size="sm"
									className="min-h-11 whitespace-nowrap sm:min-h-7"
									onClick={() => {
										if (flow.deviceCode) openExternal(flow.deviceCode.verificationUri);
									}}
								>
									<ExternalLink className="size-3.5" aria-hidden="true" />
									{t("models.loginOpenVerification")}
								</Button>
							</div>
						</div>
					)}

					{flow.authUrl && !flow.done && (
						<div className="flex flex-col gap-2 rounded-control border border-border-subtle px-3 py-2.5">
							<p className="text-sm text-text-primary">{t("models.loginBrowserOpened")}</p>
							{flow.instructions && <p className="text-xs text-text-muted">{flow.instructions}</p>}
							<Button
								variant="outline"
								size="sm"
								className="min-h-11 self-start sm:min-h-7"
								onClick={() => {
									if (!flow.authUrl) return;
									void copyUrl(flow.authUrl);
								}}
							>
								{copiedUrl === flow.authUrl ? (
									<Check className={`size-3.5 ${COPY_CHECK_CLASS}`} aria-hidden="true" />
								) : (
									<Copy className="size-3.5" aria-hidden="true" />
								)}
								{t("models.loginCopyUrl")}
							</Button>
						</div>
					)}

					<ModelLoginInput
						activeInput={activeInput}
						activeInputLabelId={activeInputLabelId}
						showSecret={showSecret}
						activeInputValue={activeInputValue}
						respondingRequestId={respondingRequestId}
						revealingSecret={revealingSecret}
						setInputDraft={setInputDraft}
						setRevealedSecret={setRevealedSecret}
						ime={ime}
						canSubmit={canSubmit}
						respond={respond}
						provider={provider}
						inputDraft={inputDraft}
						revealedSecret={revealedSecret}
						toggleSecretVisibility={toggleSecretVisibility}
						t={t}
					/>

					{responseError && (
						<FeedbackNotice tone="danger" className="text-xs">
							{t("models.loginResponseFailed", { error: responseError })}
						</FeedbackNotice>
					)}

					{flow.progress !== null && !flow.done && (
						<p aria-live="polite" className="font-mono text-xs text-text-muted">
							{flow.progress}
						</p>
					)}

					{flow.done &&
						(flow.done.ok && flow.done.credentialSynchronization === "pending" ? (
							<FeedbackNotice tone="warning" className="text-xs">
								{t("models.loginSynchronizationPending", { error: flow.done.error ?? "" })}
							</FeedbackNotice>
						) : flow.done.ok ? (
							<div
								role="status"
								className="flex items-center gap-2 rounded-control border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-success"
							>
								<Check className="size-4" aria-hidden="true" />
								{t(
									flow.done.credentialSynchronization === "recovered"
										? "models.loginSuccessRecovered"
										: "models.loginSuccess",
								)}
							</div>
						) : (
							<FeedbackNotice tone="danger" className="text-xs">
								{t("models.loginFailed", { error: flow.done.error ?? "" })}
							</FeedbackNotice>
						))}

					<DialogFooter>
						{flow.done ? (
							<Button className="min-h-11 sm:min-h-9" onClick={handleClose}>
								{t("models.close")}
							</Button>
						) : (
							<>
								<Button className="min-h-11 sm:min-h-9" variant="outline" onClick={handleClose}>
									{t("models.cancel")}
								</Button>
								{activeInput && (
									<Button
										className="min-h-11 sm:min-h-9"
										disabled={respondingRequestId !== null || revealingSecret || !canSubmit}
										onClick={() => void respond(activeInput.requestId, activeInputValue.trim())}
									>
										{t("models.loginSubmit")}
									</Button>
								)}
							</>
						)}
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ModelLoginInput({
	activeInput,
	activeInputLabelId,
	showSecret,
	activeInputValue,
	respondingRequestId,
	revealingSecret,
	setInputDraft,
	setRevealedSecret,
	ime,
	canSubmit,
	respond,
	provider,
	inputDraft,
	revealedSecret,
	toggleSecretVisibility,
	t,
}: Pick<
	ReturnType<typeof useModelLogin>,
	| "activeInput"
	| "activeInputLabelId"
	| "showSecret"
	| "activeInputValue"
	| "respondingRequestId"
	| "revealingSecret"
	| "setInputDraft"
	| "setRevealedSecret"
	| "ime"
	| "canSubmit"
	| "respond"
	| "provider"
	| "inputDraft"
	| "revealedSecret"
	| "toggleSecretVisibility"
	| "t"
>) {
	return (
		activeInput && (
			<div className="flex flex-col gap-2">
				<p id={activeInputLabelId} className="text-sm text-text-primary">
					{activeInput.message}
				</p>
				<div className="relative">
					<Input
						// eslint-disable-next-line jsx-a11y/no-autofocus -- modal dialogs own focus on open; the desktop shell has no page behind them to steal it from
						autoFocus
						type={activeInput.secret && !showSecret ? "password" : "text"}
						aria-labelledby={activeInputLabelId}
						placeholder={activeInput.placeholder ?? ""}
						value={activeInputValue}
						disabled={respondingRequestId !== null || revealingSecret}
						onChange={(event) => {
							setInputDraft(event.target.value);
							setRevealedSecret(null);
						}}
						onKeyDown={(event) => {
							if (ime.isComposing(event)) return;
							if (event.key === "Enter" && canSubmit) {
								void respond(activeInput.requestId, activeInputValue.trim());
							}
						}}
						{...ime.compositionProps}
						className={activeInput.secret ? "h-11 pr-11 font-mono sm:h-9 sm:pr-9" : "h-11 sm:h-9"}
					/>
					{activeInput.secret &&
						(provider.credentialType === "api_key" || inputDraft !== "" || revealedSecret !== null) && (
							<button
								type="button"
								disabled={respondingRequestId !== null || revealingSecret}
								onClick={() => void toggleSecretVisibility()}
								aria-label={showSecret ? t("models.hideKey") : t("models.showKey")}
								className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-50 sm:right-1 sm:w-8"
							>
								{showSecret ? (
									<EyeOff className="size-4" aria-hidden="true" />
								) : (
									<Eye className="size-4" aria-hidden="true" />
								)}
							</button>
						)}
				</div>
			</div>
		)
	);
}
