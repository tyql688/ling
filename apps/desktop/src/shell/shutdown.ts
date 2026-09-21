import { toError } from "@ling/contracts/ling-error";
import { app, BaseWindow, dialog, type BrowserWindow } from "electron";
/** Allow Host's ten-second drain plus process cleanup; a broken shell must not wait indefinitely. */
const FATAL_EXIT_TIMEOUT_MS = 20_000;
interface ShutdownOptions {
	getWindow(): BrowserWindow | null;
	dispose(): Promise<void>;
	finishGraphics(): Promise<void>;
	installOnQuit(): boolean;
}
export function createDesktopShutdown(options: ShutdownOptions) {
	let shutdownRequested = false;
	let shutdownComplete = false;
	let startupComplete = false;
	let fatalFailure: Error | null = null;
	function shutdownAndExit(relaunch: boolean): void {
		if (shutdownRequested) return;
		shutdownRequested = true;
		void options
			.dispose()
			.then(() => {
				if (fatalFailure === null) return options.finishGraphics();
			})
			.then(
				() => {
					if (fatalFailure !== null) return;
					if (relaunch) app.relaunch();
					else if (options.installOnQuit()) return;
					shutdownComplete = true;
					app.quit();
				},
				(error: unknown) => {
					console.error("Ling shell shutdown failed", error);
					if (fatalFailure !== null) return;
					shutdownComplete = true;
					app.exit(1);
				},
			)
			.catch(reportFatalFailure);
	}

	function reportFatalFailure(error: unknown): void {
		const failure = toError(error);
		console.error(`Electron shell ${startupComplete ? "runtime" : "startup"} failed`, failure);
		// A second failure is logged, but cannot start another dialog, shutdown, update or relaunch.
		if (fatalFailure !== null) return;
		shutdownComplete = false;
		fatalFailure = failure;
		let noticeWindow: BaseWindow | null = null;
		const exit = () => {
			shutdownComplete = true;
			try {
				noticeWindow?.destroy();
			} finally {
				app.exit(1);
			}
		};
		const deadline = setTimeout(() => {
			console.error("Ling fatal exit deadline reached");
			exit();
		}, FATAL_EXIT_TIMEOUT_MS);
		shutdownRequested = true;
		const cleanup = options.dispose().catch((cleanupError: unknown) => {
			console.error("Ling fatal cleanup failed", cleanupError);
		});
		const notice = app.whenReady().then(async () => {
			const title = startupComplete ? "Ling must quit" : "Ling could not start";
			// A parentless macOS message box blocks even with the Promise API, including our
			// cleanup callbacks and exit timer. Startup may need a native-only sheet parent.
			const parent =
				options.getWindow() ??
				(noticeWindow = new BaseWindow({
					title,
					width: 480,
					height: 240,
					resizable: false,
					minimizable: false,
					maximizable: false,
				}));
			if (parent.isMinimized()) parent.restore();
			parent.show();
			await dialog.showMessageBox(parent, {
				type: "error",
				title,
				message: title,
				detail: `${failure.message}\n\nLing is closing its services and will quit automatically.`,
				buttons: ["Quit Ling"],
			});
		});
		// Fatal cleanup never resumes normal operation or installs a pending update. The native
		// notice remains visible until acknowledged or the same bounded exit deadline expires.
		void Promise.allSettled([cleanup, notice]).then((outcomes) => {
			for (const outcome of outcomes) {
				if (outcome.status === "rejected") console.error("Ling fatal shutdown failed", outcome.reason);
			}
			clearTimeout(deadline);
			exit();
		});
	}
	return {
		quit: shutdownAndExit,
		reportFailure: reportFatalFailure,
		isClosing: () => shutdownRequested || shutdownComplete,
		isComplete: () => shutdownComplete,
		markStarted() {
			startupComplete = true;
		},
		async prepareInstall() {
			shutdownRequested = true;
			await options.dispose();
		},
		completeInstall() {
			if (fatalFailure !== null) throw fatalFailure;
			shutdownComplete = true;
		},
	};
}
