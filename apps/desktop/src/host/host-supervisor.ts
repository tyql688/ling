import type { UiLanguage } from "@ling/contracts/application";
import type { HostConnectionInfo, HostShellEvent } from "@ling/contracts/host-shell";

import { app, dialog, type BrowserWindow } from "electron";
import { startDesktopHostProcess, type DesktopHostProcess } from "./host-process";
import type { DesktopLog } from "../shell/log-file-sink";
interface NativeHostRecoveryCopy {
	stoppedTitle: string;
	stoppedMessage: string;
	servicesUnavailable(reason: string): string;
	exitCode(code: number | null): string;
	signal(signal: NodeJS.Signals): string;
	restartHost: string;
	quitLing: string;
	restartFailedTitle: string;
	restartFailedMessage: string;
}

const NATIVE_HOST_RECOVERY_COPY: Record<UiLanguage, NativeHostRecoveryCopy> = {
	en: {
		stoppedTitle: "Ling Host stopped",
		stoppedMessage: "Ling Host stopped unexpectedly",
		servicesUnavailable: (reason) => `Agent and project services are unavailable (${reason}).`,
		exitCode: (code) => `exit code ${code === null ? "unknown" : String(code)}`,
		signal: (signal) => `signal ${signal}`,
		restartHost: "Restart Host",
		quitLing: "Quit Ling",
		restartFailedTitle: "Ling could not restart",
		restartFailedMessage: "Ling Host could not be restarted. Quit Ling and open it again.",
	},
	"zh-CN": {
		stoppedTitle: "Ling Host 已停止",
		stoppedMessage: "Ling Host 意外停止",
		servicesUnavailable: (reason) => `Agent 与项目服务当前不可用（${reason}）。`,
		exitCode: (code) => `退出代码 ${code === null ? "未知" : String(code)}`,
		signal: (signal) => `信号 ${signal}`,
		restartHost: "重新启动 Host",
		quitLing: "退出 Ling",
		restartFailedTitle: "Ling 无法重新启动 Host",
		restartFailedMessage: "无法重新启动 Ling Host。请退出 Ling 后重新打开。",
	},
	ja: {
		stoppedTitle: "Ling Host が停止しました",
		stoppedMessage: "Ling Host が予期せず停止しました",
		servicesUnavailable: (reason) => `エージェントとプロジェクトのサービスを利用できません（${reason}）。`,
		exitCode: (code) => `終了コード ${code === null ? "不明" : String(code)}`,
		signal: (signal) => `シグナル ${signal}`,
		restartHost: "Host を再起動",
		quitLing: "Ling を終了",
		restartFailedTitle: "Ling を再起動できません",
		restartFailedMessage: "Ling Host を再起動できませんでした。Ling を終了し、再度開いてください。",
	},
	ko: {
		stoppedTitle: "Ling Host가 중지되었습니다",
		stoppedMessage: "Ling Host가 예기치 않게 중지되었습니다",
		servicesUnavailable: (reason) => `에이전트 및 프로젝트 서비스를 사용할 수 없습니다(${reason}).`,
		exitCode: (code) => `종료 코드 ${code === null ? "알 수 없음" : String(code)}`,
		signal: (signal) => `신호 ${signal}`,
		restartHost: "Host 다시 시작",
		quitLing: "Ling 종료",
		restartFailedTitle: "Ling을 다시 시작할 수 없습니다",
		restartFailedMessage: "Ling Host를 다시 시작할 수 없습니다. Ling을 종료한 뒤 다시 열어 주세요.",
	},
};

/** Native recovery UI uses the OS locale until the renderer synchronizes its persisted selection. */
function uiLanguageFromSystemLocale(locale: string): UiLanguage {
	const normalized = locale.toLowerCase();
	if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
	if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
	return normalized === "zh-cn" || normalized.startsWith("zh-hans") ? "zh-CN" : "en";
}
interface SupervisorOptions {
	appResourcesRoot: string;
	userDataDirectory: string;
	desktopLog: DesktopLog;
	getWindow(): BrowserWindow | null;
	onShellEvent(event: HostShellEvent): void;
	onConnected(connection: HostConnectionInfo): Promise<void>;
	onUnavailable(): void;
	onFailure(error: unknown): void;
}
export function createDesktopHostSupervisor(options: SupervisorOptions) {
	let hostProcess: DesktopHostProcess | null = null;
	let hostLaunch: Promise<DesktopHostProcess> | null = null;
	let hostRestartPromptOpen = false;
	let stopped = false;
	let uiLanguage: UiLanguage = "en";
	let disposal: Promise<void> | null = null;
	async function launchHost(): Promise<DesktopHostProcess> {
		if (stopped) throw new Error("Ling is shutting down");
		if (hostLaunch) return hostLaunch;
		const pending = startDesktopHostProcess({
			appResourcesRoot: options.appResourcesRoot,
			userDataDirectory: options.userDataDirectory,
			desktopLog: options.desktopLog,
			onShellEvent: options.onShellEvent,
			onUnexpectedExit: (details) => void handleUnexpectedHostExit(details).catch(options.onFailure),
		}).then((host) => {
			hostProcess = host;
			return host;
		});
		hostLaunch = pending;
		try {
			return await pending;
		} finally {
			if (hostLaunch === pending) hostLaunch = null;
		}
	}
	function currentHostConnection() {
		const host = hostProcess;
		if (!host || host.child.exitCode !== null || host.child.signalCode !== null || host.child.killed) {
			throw new Error("Ling Host is not connected");
		}
		return host.connection;
	}
	async function handleUnexpectedHostExit(details: {
		pid: number;
		code: number | null;
		signal: NodeJS.Signals | null;
	}): Promise<void> {
		if (stopped || hostRestartPromptOpen || hostProcess?.child.pid !== details.pid) return;
		hostProcess = null;
		options.onUnavailable();
		hostRestartPromptOpen = true;
		const copy = NATIVE_HOST_RECOVERY_COPY[uiLanguage];
		const reason = details.signal === null ? copy.exitCode(details.code) : copy.signal(details.signal);
		console.error(`Ling Host exited unexpectedly (${reason})`);
		try {
			const noticeOptions: Electron.MessageBoxOptions = {
				type: "error",
				title: copy.stoppedTitle,
				message: copy.stoppedMessage,
				detail: copy.servicesUnavailable(reason),
				buttons: [copy.restartHost, copy.quitLing],
				defaultId: 0,
				cancelId: 1,
			};
			const window = options.getWindow();
			const { response } = window
				? await dialog.showMessageBox(window, noticeOptions)
				: await dialog.showMessageBox(noticeOptions);
			if (response !== 0) {
				app.quit();
				return;
			}
			if (stopped) return;
			const replacement = await launchHost();
			if (stopped) return;
			hostProcess = replacement;
			await options.onConnected(replacement.connection);
		} catch (error) {
			console.error("Ling Host restart failed", error);
			dialog.showErrorBox(copy.restartFailedTitle, copy.restartFailedMessage);
			app.quit();
		} finally {
			hostRestartPromptOpen = false;
		}
	}
	return {
		launch: launchHost,
		connection: currentHostConnection,
		peek: () => hostProcess?.connection ?? null,
		setLanguage(language: UiLanguage) {
			uiLanguage = language;
		},
		initializeLanguage() {
			uiLanguage = uiLanguageFromSystemLocale(app.getLocale());
			return uiLanguage;
		},
		stop() {
			stopped = true;
		},
		dispose() {
			if (disposal) return disposal;
			stopped = true;
			const owned = hostLaunch ? hostLaunch : Promise.resolve(hostProcess);
			disposal = owned.then(async (host) => {
				await host?.dispose();
				hostProcess = null;
			});
			return disposal;
		},
	};
}
