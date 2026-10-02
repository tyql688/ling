import type { UpdateEvent, UpdateState } from "@ling/contracts/update";
import { errorMessage } from "@ling/contracts/ling-error";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { appModeAtom } from "@renderer/lib/navigation-state";
import { cn } from "@renderer/lib/utils";
import { useSetAtom } from "jotai";
import { ArrowDownToLine, CircleAlert, CircleArrowUp, LoaderCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UpdateContext, useUpdates } from "./update-context";

export function UpdateProvider({ children }: { children: ReactNode }) {
	const updates = useDomainApi("updates");
	const windowApi = useDomainApi("window");
	const setMode = useSetAtom(appModeAtom);
	const { t } = useTranslation();
	const [state, setState] = useState<UpdateState | null>(null);
	const [phase, setPhase] = useState<UpdateEvent | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const running = useRef(false);
	const revision = useRef(0);
	const mounted = useRef(false);
	const report = useCallback((error: unknown) => {
		if (!mounted.current) return;
		setPhase((current) =>
			current?.type === "error" && current.restartRequired ? current : { type: "error", message: errorMessage(error) },
		);
	}, []);
	const refresh = useCallback(async () => {
		const started = revision.current;
		const snapshot = await updates.getState();
		if (mounted.current) {
			setState(snapshot);
			if (revision.current === started) setPhase(snapshot.event);
		}
		return snapshot;
	}, [updates]);
	useEffect(() => {
		mounted.current = true;
		const unsubscribe = updates.onEvent((event) => {
			revision.current += 1;
			setPhase(event);
		});
		void refresh().catch(report);
		return () => {
			mounted.current = false;
			unsubscribe();
		};
	}, [updates, refresh, report]);
	const run = useCallback(
		(action: () => Promise<unknown>) => {
			if (running.current) return;
			running.current = true;
			setBusy(true);
			void action()
				.catch(report)
				.finally(() => {
					running.current = false;
					if (mounted.current) setBusy(false);
				});
		},
		[report],
	);
	const downloadUpdate = useCallback(() => run(updates.download), [run, updates]);
	const installUpdate = useCallback(() => run(updates.install), [run, updates]);
	const check = useCallback(
		() =>
			run(async () => {
				const snapshot = await refresh();
				const event = snapshot.event;
				if (
					snapshot.supported &&
					(event === null || event.type === "not-available" || (event.type === "error" && !event.restartRequired))
				)
					await updates.check();
			}),
		[refresh, run, updates],
	);
	const openUpdates = useCallback(() => {
		setOpen(true);
		check();
	}, [check]);
	useEffect(() => {
		let cancelled = false;
		const receive = () => {
			void windowApi
				.takePendingCommand()
				.then((command) => {
					if (cancelled || command === null) return;
					if (command === "settings") {
						setOpen(false);
						setMode("settings");
					} else openUpdates();
				})
				.catch((error: unknown) => {
					if (!cancelled) {
						setOpen(true);
						report(error);
					}
				});
		};
		const unsubscribe = windowApi.onCommandPending(receive);
		receive();
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [windowApi, openUpdates, report, setMode]);

	const status = (() => {
		switch (phase?.type) {
			case undefined:
				return state === null
					? t("common.loading")
					: state.supported
						? t("settings.updateCheck")
						: t("settings.updateUnsupported");
			case "checking":
				return t("settings.updateChecking");
			case "not-available":
				return t("settings.updateNone");
			case "available":
				return t("settings.updateAvailable", { version: phase.version });
			case "download-progress":
				return t("settings.updateDownloading", { percent: phase.percent });
			case "downloaded":
				return t("settings.updateDownloaded", { version: phase.version });
			case "installing":
				return t("settings.updateInstalling");
			case "error":
				return phase.restartRequired
					? t("settings.updateRestartRequired", { message: phase.message })
					: t("settings.updateFailed", { message: phase.message });
		}
	})();
	return (
		<UpdateContext value={{ state, phase, busy, openUpdates, downloadUpdate, installUpdate }}>
			{children}
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent size="small" className="space-y-5">
					<DialogHeader className="pr-7">
						<DialogTitle>{t("settings.updateCheck")}</DialogTitle>
						<DialogDescription>
							{t("settings.version")} {state?.appVersion}
						</DialogDescription>
					</DialogHeader>
					<DialogCloseButton aria-label={t("settings.updateClose")} />
					<p
						role="status"
						className={cn("text-sm break-words", phase?.type === "error" ? "text-danger" : "text-text-secondary")}
					>
						{status}
					</p>
					{phase?.type === "download-progress" && (
						<progress
							className="h-1.5 w-full accent-accent"
							value={phase.percent}
							max={100}
							aria-label={t("settings.updateDownloading", { percent: phase.percent })}
						/>
					)}
					{phase?.type === "downloaded" && (
						<p className="text-xs text-text-muted">{t("settings.updateInstallOnQuit")}</p>
					)}
					<DialogFooter>
						{(state === null || state.supported) &&
							(phase === null ||
								phase.type === "not-available" ||
								(phase.type === "error" && !phase.restartRequired)) && (
								<Button size="sm" disabled={busy} onClick={check}>
									{t("settings.updateCheck")}
								</Button>
							)}
						{state?.supported && phase?.type === "available" && (
							<Button size="sm" disabled={busy} onClick={downloadUpdate}>
								{t("settings.updateDownload")}
							</Button>
						)}
						{state?.supported && phase?.type === "downloaded" && (
							<Button size="sm" disabled={busy} onClick={installUpdate}>
								{t("settings.updateInstall")}
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</UpdateContext>
	);
}

export function UpdateButton() {
	const { capabilities } = useDomainApi("ui");
	const { phase, busy, openUpdates, downloadUpdate, installUpdate } = useUpdates();
	const { t } = useTranslation();
	if (!capabilities.updates || !phase || phase.type === "checking" || phase.type === "not-available") return null;
	const ready = phase.type === "available" || phase.type === "downloaded";
	const spinning = phase.type === "download-progress" || phase.type === "installing" || (busy && ready);
	const label = (() => {
		switch (phase.type) {
			case "available":
				return t("settings.updateDownload");
			case "download-progress":
				return t("settings.updateDownloading", { percent: phase.percent });
			case "downloaded":
				return t("settings.updateInstall");
			case "installing":
				return t("settings.updateInstalling");
			case "error":
				return phase.restartRequired
					? t("settings.updateRestartRequired", { message: phase.message })
					: t("settings.updateFailed", { message: phase.message });
		}
	})();
	return (
		<TooltipIconButton
			label={label}
			onClick={phase.type === "available" ? downloadUpdate : phase.type === "downloaded" ? installUpdate : openUpdates}
			disabled={(busy && ready) || phase.type === "installing"}
			className={cn("ml-auto", ready && "text-accent", phase.type === "error" && "text-danger")}
		>
			{spinning ? (
				<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
			) : phase.type === "available" ? (
				<ArrowDownToLine className="size-4" aria-hidden="true" />
			) : phase.type === "error" ? (
				<CircleAlert className="size-4" aria-hidden="true" />
			) : (
				<CircleArrowUp className="size-4" aria-hidden="true" />
			)}
		</TooltipIconButton>
	);
}
