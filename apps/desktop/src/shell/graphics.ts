import { app, dialog, type BrowserWindow } from "electron";
import { readGraphicsState, writeGraphicsState } from "../state/graphics-state";
/** Three GPU or renderer process failures inside 5 minutes mean the hardware-rendering path is not stable. */
const RENDERING_PROCESS_FAILURE_WINDOW_MS = 5 * 60_000;

const RENDERING_PROCESS_FAILURE_THRESHOLD = 3;

/** A fallback run without rendering-process failures for 10 minutes is eligible to try hardware acceleration again. */
const GRAPHICS_FALLBACK_CLEAN_RUN_MS = 10 * 60_000;
interface GraphicsOptions {
	userDataDirectory: string;
	getWindow(): BrowserWindow | null;
	relaunch(): void;
	onFailure(error: unknown): void;
}
export function createDesktopGraphics(options: GraphicsOptions) {
	let graphicsState = { softwareRendering: false, autoFallback: false };
	const renderingProcessFailureTimes: number[] = [];
	let graphicsFallbackPending = false;
	const BOOT_EPOCH = Date.now();
	let stopped = false;
	let writes: Promise<void> = Promise.resolve();
	function persistGraphicsState() {
		const next = graphicsState;
		writes = writes.then(
			() => writeGraphicsState(options.userDataDirectory, next),
			() => writeGraphicsState(options.userDataDirectory, next),
		);
		return writes;
	}
	function noteRenderingProcessFailure(): void {
		if (stopped) return;
		const now = Date.now();
		while (renderingProcessFailureTimes.length > 0) {
			const oldest = renderingProcessFailureTimes[0];
			if (oldest === undefined || now - oldest <= RENDERING_PROCESS_FAILURE_WINDOW_MS) break;
			renderingProcessFailureTimes.shift();
		}
		renderingProcessFailureTimes.push(now);
		if (
			renderingProcessFailureTimes.length < RENDERING_PROCESS_FAILURE_THRESHOLD ||
			graphicsState.softwareRendering ||
			graphicsFallbackPending
		)
			return;
		graphicsFallbackPending = true;
		void triggerGraphicsFallback().catch(options.onFailure);
	}

	async function triggerGraphicsFallback(): Promise<void> {
		graphicsState = { softwareRendering: true, autoFallback: true };
		try {
			await persistGraphicsState();
		} catch (error: unknown) {
			console.error("Could not save Ling graphics state", error);
		}
		const noticeOptions: Electron.MessageBoxOptions = {
			type: "warning",
			title: "Ling graphics",
			message: "Ling's rendering processes keep stopping",
			detail:
				"Ling will use software rendering after the next start to stay stable. Once it runs stably, hardware acceleration turns back on automatically.",
			buttons: ["Restart Now", "Restart Later"],
			defaultId: 0,
			cancelId: 1,
			noLink: true,
		};
		try {
			const window = options.getWindow();
			const { response } = window
				? await dialog.showMessageBox(window, noticeOptions)
				: await dialog.showMessageBox(noticeOptions);
			if (response === 0 && !stopped) options.relaunch();
		} finally {
			graphicsFallbackPending = false;
		}
	}

	async function updateGraphicsPreference(softwareRendering: boolean): Promise<void> {
		// An explicit host preference replaces any automatic fallback.
		graphicsState = { softwareRendering, autoFallback: false };
		try {
			await persistGraphicsState();
		} catch (error: unknown) {
			console.error("Could not save Ling graphics state", error);
		}
	}

	async function maybeRevertGraphicsFallback(): Promise<void> {
		const ranLongEnough = Date.now() - BOOT_EPOCH >= GRAPHICS_FALLBACK_CLEAN_RUN_MS;
		if (!graphicsState.autoFallback || renderingProcessFailureTimes.length > 0 || !ranLongEnough) return;
		graphicsState = { softwareRendering: false, autoFallback: false };
		try {
			await persistGraphicsState();
		} catch (error: unknown) {
			console.error("Could not save Ling graphics state", error);
		}
	}
	return {
		initialize() {
			graphicsState = readGraphicsState(options.userDataDirectory);
			if (graphicsState.softwareRendering) app.disableHardwareAcceleration();
		},
		noteFailure: noteRenderingProcessFailure,
		setPreference: updateGraphicsPreference,
		finishCleanRun: maybeRevertGraphicsFallback,
		stop() {
			stopped = true;
		},
		dispose: () => writes,
	};
}
