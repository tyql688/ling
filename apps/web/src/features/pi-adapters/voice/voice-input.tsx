import { sessionKey, sameSessionRef, type SessionRef } from "@ling/contracts/session-ref";
import { VOICE_MAX_SECONDS } from "@ling/contracts/voice";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { ComposerFeedback } from "@renderer/components/workbench/composer-feedback";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";
import {
	activeSessionRefAtom,
	extensionUiSnapshotFamily,
	sessionTranscriptStateFamily,
	dismissedVoiceSettingsRequestFamily,
} from "@renderer/features/sessions/state/session";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { isShortcutModifier } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { useAtom, useAtomValue } from "jotai";
import { Mic, Settings2, Square, X, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { captureMicrophone, type MicrophoneCapture } from "./microphone-capture";
import { VoiceSettings } from "./voice-settings";
import { VoiceError } from "./voice-error";
import { voiceShortcut, voiceSettingsShortcut } from "./voice-shortcuts";

export function VoiceInput({
	sessionRef,
	disabled,
	onTranscript,
}: {
	sessionRef: SessionRef;
	disabled: boolean;
	onTranscript(text: string): boolean;
}) {
	const features = useBuiltinFeatures();
	const active = useAtomValue(activeSessionRefAtom);
	const binding = useAtomValue(sessionTranscriptStateFamily(sessionKey(sessionRef)));
	const extension = useAtomValue(extensionUiSnapshotFamily(sessionKey(sessionRef)));
	const request = extension?.state.voiceSettingsRequestId ?? null;
	const [dismissedRequest, setDismissedRequest] = useAtom(dismissedVoiceSettingsRequestFamily(sessionKey(sessionRef)));
	if (!features.value?.enabled.voice || !sameSessionRef(active, sessionRef)) return null;
	return (
		<VoiceInputControls
			key={sessionKey(sessionRef)}
			runtimeBinding={`${binding.runtimeId}:${binding.generation}:${binding.epoch}`}
			cwd={sessionRef.cwd}
			request={request}
			dismissedRequest={dismissedRequest}
			onDismissRequest={() => setDismissedRequest(request)}
			disabled={disabled}
			onTranscript={onTranscript}
		/>
	);
}

/** Project drafts can be dictated before their first session is created. */
export function ProjectVoiceInput({
	cwd,
	disabled,
	onTranscript,
}: {
	cwd: string;
	disabled: boolean;
	onTranscript(text: string): boolean;
}) {
	const features = useBuiltinFeatures();
	const active = useAtomValue(activeSessionRefAtom);
	if (!features.value?.enabled.voice || active) return null;
	return (
		<VoiceInputControls key={cwd} cwd={cwd} runtimeBinding={cwd} disabled={disabled} onTranscript={onTranscript} />
	);
}

function VoiceInputControls({
	cwd,
	request = null,
	dismissedRequest = null,
	onDismissRequest,
	runtimeBinding,
	disabled,
	onTranscript,
}: {
	cwd: string;
	request?: string | null;
	dismissedRequest?: string | null;
	onDismissRequest?(): void;
	runtimeBinding: string;
	disabled: boolean;
	onTranscript(text: string): boolean;
}) {
	const { t } = useTranslation();
	const api = useDomainApi("voice");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
	const [error, setError] = useState<{ cause: unknown } | { message: "noSpeech" | "draftFull" } | null>(null);
	const [announcement, setAnnouncement] = useState<"inserted" | "cancelled" | null>(null);
	const [level, setLevel] = useState(0);
	const [seconds, setSeconds] = useState(0);
	const [transcript, setTranscript] = useState<string | null>(null);
	const operation = useRef<{
		id: string;
		abort: AbortController;
		capture: MicrophoneCapture | null;
		pcm: string | null;
		processing: boolean;
	} | null>(null);
	const alive = useRef(false);
	const button = useRef<HTMLButtonElement>(null);
	const latest = useRef({ onTranscript });
	latest.current = { onTranscript };
	function report(cause: unknown) {
		if (alive.current) setError({ cause });
	}
	async function cancel(announce = true) {
		const current = operation.current;
		operation.current = null;
		if (alive.current) {
			setPhase("idle");
			setLevel(0);
			if (current && announce) setAnnouncement("cancelled");
		}
		if (current) {
			current.abort.abort();
			await Promise.all([current.capture?.cancel(), api.cancel({ operationId: current.id })]);
		}
	}
	const cancelRef = useRef(cancel);
	cancelRef.current = cancel;
	useEffect(() => {
		alive.current = true;
		const hide = () => {
			if (document.hidden) void cancelRef.current().catch(report);
		};
		document.addEventListener("visibilitychange", hide);
		return () => {
			alive.current = false;
			document.removeEventListener("visibilitychange", hide);
			void cancelRef.current().catch((cause: unknown) => console.error("Voice cleanup failed", cause));
		};
	}, [runtimeBinding]);
	useEffect(() => {
		if (phase !== "recording") return;
		const started = Date.now();
		const timer = setInterval(
			() => setSeconds(Math.min(VOICE_MAX_SECONDS, Math.floor((Date.now() - started) / 1000))),
			1000,
		);
		return () => clearInterval(timer);
	}, [phase]);
	async function stop() {
		const current = operation.current;
		if (!current || current.processing || (!current.capture && !current.pcm)) return;
		current.processing = true;
		setPhase("transcribing");
		setError(null);
		try {
			const capture = current.capture;
			// A decoder failure must not leave a disposed capture blocking the next recording.
			current.capture = null;
			current.pcm ??= await capture!.stop();
			current.abort.signal.throwIfAborted();
			const result = await api.transcribe({ cwd, operationId: current.id, pcm: current.pcm });
			if (!alive.current || operation.current !== current) return;
			if (!result.text) setError({ message: "noSpeech" });
			else if (!latest.current.onTranscript(result.text)) {
				setTranscript(result.text);
				setError({ message: "draftFull" });
			} else setAnnouncement("inserted");
			operation.current = null;
		} catch (cause) {
			if (alive.current && operation.current === current) {
				report(cause);
				if (!current.pcm) operation.current = null;
			}
		} finally {
			current.processing = false;
			if (alive.current && !current.abort.signal.aborted && (operation.current === current || !operation.current)) {
				setPhase("idle");
				setLevel(0);
			}
		}
	}
	const stopRef = useRef(stop);
	stopRef.current = stop;
	async function start() {
		if (phase !== "idle" || operation.current || transcript || disabled) return;
		setError(null);
		setAnnouncement(null);
		setSeconds(0);
		setPhase("starting");
		const current = {
			id: crypto.randomUUID(),
			abort: new AbortController(),
			capture: null as MicrophoneCapture | null,
			pcm: null,
			processing: false,
		};
		operation.current = current;
		try {
			const overview = await api.read({ cwd });
			current.abort.signal.throwIfAborted();
			if (!overview.configuration) {
				operation.current = null;
				setPhase("idle");
				setSettingsOpen(true);
				return;
			}
			current.capture = await captureMicrophone({
				signal: current.abort.signal,
				onLevel: (value) => {
					if (alive.current && operation.current === current) setLevel(value);
				},
				onLimit: () => {
					if (operation.current !== current) return;
					void stopRef.current();
				},
				onError: (cause) => {
					if (operation.current !== current) return;
					report(cause);
					void cancelRef.current(false).catch(report);
				},
			});
			current.abort.signal.throwIfAborted();
			if (alive.current) setPhase("recording");
		} catch (cause) {
			if (alive.current && operation.current === current) {
				report(cause);
				await cancel(false).catch(report);
			}
		}
	}
	const recording = phase === "recording";
	const working = phase === "starting" || phase === "transcribing";
	const retry = phase === "idle" && Boolean(operation.current?.pcm);
	const label = t(recording ? "voice.stop" : working ? "voice.cancelOperation" : retry ? "voice.retry" : "voice.start");
	const showSettings = settingsOpen || (request !== null && request !== dismissedRequest);
	const unavailable = phase === "idle" && (disabled || transcript !== null);
	async function performAction() {
		if (unavailable || showSettings) return;
		if (working) await cancel();
		else if (recording || retry) await stop();
		else await start();
	}
	const keyboard = useRef<(event: KeyboardEvent) => void>(() => {});
	keyboard.current = (event) => {
		if (
			event.defaultPrevented ||
			event.isComposing ||
			event.repeat ||
			event.getModifierState("AltGraph") ||
			document.hidden ||
			showSettings ||
			document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
		)
			return;
		if (event.key === "Escape" && operation.current) {
			event.preventDefault();
			event.stopPropagation();
			void cancel().catch(report);
		} else if (isShortcutModifier(event) && event.altKey && event.code === "KeyV") {
			event.preventDefault();
			event.stopPropagation();
			if (event.shiftKey) {
				if (phase === "idle") setSettingsOpen(true);
			} else void performAction().catch(report);
		}
	};
	useEffect(() => {
		// The shortcut belongs to this visible composer, not settings, terminals or other editors.
		const composer = button.current?.closest<HTMLElement>("[data-composer-card]");
		const handle = (event: KeyboardEvent) => {
			if (!composer?.getClientRects().length || composer.closest('[inert], [aria-hidden="true"]')) return;
			keyboard.current(event);
		};
		composer?.addEventListener("keydown", handle, true);
		return () => composer?.removeEventListener("keydown", handle, true);
	}, []);
	return (
		<>
			<div className="flex shrink-0 items-center gap-1">
				<ContextMenu>
					<ContextMenuTrigger className="inline-flex">
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										ref={button}
										variant="ghost"
										size="icon"
										className={cn("size-7 text-text-muted", recording && "bg-surface-hover text-text-primary")}
										aria-label={label}
										aria-pressed={recording}
										aria-keyshortcuts="Control+Alt+V Meta+Alt+V"
										disabled={unavailable}
										onClick={() => void performAction().catch(report)}
									/>
								}
							>
								{working ? (
									<span className="ling-spin motion-reduce:animate-none!">
										<LoaderCircle className="size-4" aria-hidden="true" />
									</span>
								) : recording ? (
									<Square className="size-3.5 fill-current" aria-hidden="true" />
								) : retry ? (
									<RotateCcw className="size-4" aria-hidden="true" />
								) : (
									<Mic className="size-4" aria-hidden="true" />
								)}
							</TooltipTrigger>
							<TooltipContent shortcut={voiceShortcut}>
								<span>
									{working ? t(`voice.${phase}`) : label}
									<span className="mt-0.5 block font-normal">{working ? label : t("voice.menuHint")}</span>
								</span>
							</TooltipContent>
						</Tooltip>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem disabled={unavailable} onSelect={() => void performAction().catch(report)}>
							<Mic className="size-3.5" aria-hidden="true" />
							{label}
							<span className="ml-auto pl-4 text-xs text-text-muted">{voiceShortcut}</span>
						</ContextMenuItem>
						{(recording || retry) && (
							<ContextMenuItem onSelect={() => void cancel().catch(report)}>
								<X className="size-3.5" aria-hidden="true" />
								{t("voice.discard")}
							</ContextMenuItem>
						)}
						<ContextMenuSeparator />
						<ContextMenuItem disabled={phase !== "idle"} onSelect={() => setSettingsOpen(true)}>
							<Settings2 className="size-3.5" aria-hidden="true" />
							{t("voice.settings")}
							<span className="ml-auto pl-4 text-xs text-text-muted">{voiceSettingsShortcut}</span>
						</ContextMenuItem>
					</ContextMenuContent>
				</ContextMenu>
				{recording && (
					<span aria-hidden="true" className="flex items-center gap-1 text-xs tabular-nums text-text-primary">
						<span className="h-1.5 w-4 overflow-hidden rounded-full bg-surface-hover">
							<span
								className="block size-full origin-left bg-text-primary"
								style={{ transform: `scaleX(${Math.max(0.05, level)})` }}
							/>
						</span>
						{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
					</span>
				)}
				<span role="status" className="sr-only">
					{phase !== "idle" ? t(`voice.${phase}`) : announcement ? t(`voice.${announcement}`) : ""}
				</span>
			</div>
			{(error || transcript) && (
				<ComposerFeedback>
					<FeedbackNotice
						tone={error && "cause" in error ? "danger" : "warning"}
						action={
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("feedback.dismiss")}
								onClick={() => {
									setError(null);
									setTranscript(null);
								}}
							>
								<X className="size-3.5" />
							</Button>
						}
					>
						{error && ("cause" in error ? <VoiceError error={error.cause} /> : t(`voice.${error.message}`))}
						{transcript && (
							<>
								<p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">{transcript}</p>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => {
										if (onTranscript(transcript)) {
											setTranscript(null);
											setError(null);
										}
									}}
								>
									{t("voice.insert")}
								</Button>
							</>
						)}
					</FeedbackNotice>
				</ComposerFeedback>
			)}
			{showSettings && (
				<VoiceSettings
					cwd={cwd}
					returnFocusRef={button}
					onClose={() => {
						setSettingsOpen(false);
						onDismissRequest?.();
					}}
				/>
			)}
		</>
	);
}
