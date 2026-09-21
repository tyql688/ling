import type { TerminalTypography } from "./terminal-preferences";
import type { LingApi } from "@ling/contracts/api/ling-api";
import type { createTerminalEmulator } from "./terminal-emulator";
import type {
	TerminalAttachResult,
	TerminalOutputChunk,
	TerminalRefRequest,
	TerminalSnapshot,
} from "@ling/contracts/terminal";
import { TERMINAL_INPUT_MAX_CHARS } from "@ling/contracts/terminal";
import { appPlatform } from "@renderer/lib/platform";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { IDisposable, ITheme, Terminal as XTermTerminal } from "@xterm/xterm";

/** Terminal keyboard input batching delay; ~4ms merges rapid keystrokes, cutting IPC round-trips without feeling laggy. */
const INPUT_BATCH_DELAY_MS = 4;
/**
 * The renderer should hold out-of-order output only briefly. Normal output goes straight
 * to xterm and is confirmed via the write callback ACK; if a sequence goes permanently
 * missing, switch to attach replay resync before this hard cap so the Map cannot grow unbounded.
 */
const PENDING_OUTPUT_MAX_CHARS = 256_000;
const PENDING_OUTPUT_MAX_CHUNKS = 256;
/** Total stdin queued but not yet IPC-completed; oversized pastes must be rejected explicitly instead of letting the Promise chain grow unbounded. */
const PENDING_INPUT_MAX_CHARS = 256_000;
/** Character caps alone still allow hundreds of thousands of one-char Promise closures. */
const PENDING_INPUT_MAX_OPERATIONS = 64;
/** xterm must not paint a second panel behind Ling's workbench material. */
const TRANSPARENT_TERMINAL_BACKGROUND = "#00000000";

type TerminalOutputQueueState = "ready" | "gap" | "resync" | "failed";

export interface TerminalRuntime {
	api: Pick<LingApi["terminal"], "input" | "resize" | "ack">;
	snapshot: TerminalSnapshot;
	title: string;
	xterm: XTermTerminal;
	fitAddon: FitAddon;
	searchAddon: SearchAddon;
	opened: boolean;
	replayTruncated: boolean;
	disposed: boolean;
	expectedSequence: number | null;
	pendingChunks: Map<number, TerminalOutputChunk>;
	pendingChunkChars: number;
	resyncing: boolean;
	resyncRequired: boolean;
	resyncAttempts: number;
	resyncRetryTimer: number | null;
	resyncFailed: boolean;
	inputBuffer: string;
	inputQueuedChars: number;
	inputQueuedOperations: number;
	inputCapacityErrorReported: boolean;
	inputTimer: number | null;
	inputTail: Promise<void>;
	lastSentCols: number;
	lastSentRows: number;
	disposables: IDisposable[];
}

function cssColor(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function xtermTheme(): ITheme {
	return {
		background: TRANSPARENT_TERMINAL_BACKGROUND,
		foreground: cssColor("--color-text-primary"),
		cursor: cssColor("--color-text-primary"),
		cursorAccent: cssColor("--color-popover"),
		selectionBackground: cssColor("--color-accent-muted"),
		black: cssColor("--ansi-black"),
		red: cssColor("--ansi-red"),
		green: cssColor("--ansi-green"),
		yellow: cssColor("--ansi-yellow"),
		blue: cssColor("--ansi-blue"),
		magenta: cssColor("--ansi-magenta"),
		cyan: cssColor("--ansi-cyan"),
		white: cssColor("--ansi-white"),
		brightBlack: cssColor("--ansi-bright-black"),
		brightRed: cssColor("--ansi-bright-red"),
		brightGreen: cssColor("--ansi-bright-green"),
		brightYellow: cssColor("--ansi-bright-yellow"),
		brightBlue: cssColor("--ansi-bright-blue"),
		brightMagenta: cssColor("--ansi-bright-magenta"),
		brightCyan: cssColor("--ansi-bright-cyan"),
		brightWhite: cssColor("--ansi-bright-white"),
	};
}

export function terminalRef(snapshot: TerminalSnapshot): TerminalRefRequest {
	return { terminalId: snapshot.id, generation: snapshot.generation };
}

function enqueueInputWrite(runtime: TerminalRuntime, data: string, onError: (error: unknown) => void): void {
	if (runtime.inputQueuedOperations >= PENDING_INPUT_MAX_OPERATIONS) {
		runtime.inputQueuedChars = Math.max(0, runtime.inputQueuedChars - data.length);
		if (!runtime.inputCapacityErrorReported) {
			runtime.inputCapacityErrorReported = true;
			onError(new Error("Terminal input queue is full. The latest input was not sent."));
		}
		return;
	}
	runtime.inputQueuedOperations += 1;
	runtime.inputTail = runtime.inputTail
		.then(() => runtime.api.input({ ...terminalRef(runtime.snapshot), data }))
		.catch(onError)
		.finally(() => {
			runtime.inputQueuedOperations = Math.max(0, runtime.inputQueuedOperations - 1);
			runtime.inputQueuedChars = Math.max(0, runtime.inputQueuedChars - data.length);
			if (
				runtime.inputQueuedChars <= PENDING_INPUT_MAX_CHARS / 2 &&
				runtime.inputQueuedOperations <= PENDING_INPUT_MAX_OPERATIONS / 2
			) {
				runtime.inputCapacityErrorReported = false;
			}
		});
}

function flushInput(runtime: TerminalRuntime, onError: (error: unknown) => void): void {
	if (runtime.inputTimer !== null) {
		window.clearTimeout(runtime.inputTimer);
		runtime.inputTimer = null;
	}
	while (runtime.inputBuffer.length > 0) {
		let splitAt = Math.min(TERMINAL_INPUT_MAX_CHARS, runtime.inputBuffer.length);
		const previous = runtime.inputBuffer.charCodeAt(splitAt - 1);
		if (previous >= 0xd800 && previous <= 0xdbff && splitAt < runtime.inputBuffer.length) splitAt -= 1;
		const data = runtime.inputBuffer.slice(0, splitAt);
		runtime.inputBuffer = runtime.inputBuffer.slice(data.length);
		enqueueInputWrite(runtime, data, onError);
	}
}

function enqueueInput(runtime: TerminalRuntime, data: string, onError: (error: unknown) => void): void {
	if (runtime.disposed || data.length === 0) return;
	if (
		runtime.inputQueuedChars + data.length > PENDING_INPUT_MAX_CHARS ||
		runtime.inputQueuedOperations >= PENDING_INPUT_MAX_OPERATIONS
	) {
		if (!runtime.inputCapacityErrorReported) {
			runtime.inputCapacityErrorReported = true;
			onError(new Error("Terminal input queue is full. The latest input was not sent."));
		}
		return;
	}
	runtime.inputQueuedChars += data.length;
	runtime.inputBuffer += data;
	if (runtime.inputBuffer.length >= TERMINAL_INPUT_MAX_CHARS) {
		flushInput(runtime, onError);
		return;
	}
	if (runtime.inputTimer !== null) return;
	runtime.inputTimer = window.setTimeout(() => flushInput(runtime, onError), INPUT_BATCH_DELAY_MS);
}

function drainOutput(runtime: TerminalRuntime, onError: (error: unknown) => void): void {
	if (runtime.expectedSequence === null || runtime.disposed || runtime.resyncing) return;
	for (;;) {
		const chunk = runtime.pendingChunks.get(runtime.expectedSequence);
		if (!chunk) break;
		runtime.pendingChunks.delete(runtime.expectedSequence);
		runtime.pendingChunkChars -= chunk.data.length;
		runtime.expectedSequence += 1;
		runtime.xterm.write(chunk.data, () => {
			if (!chunk.ackRequired) return;
			void runtime.api
				.ack({
					terminalId: chunk.terminalId,
					generation: chunk.generation,
					sequence: chunk.sequence,
					ackUnits: chunk.ackUnits,
				})
				.catch(onError);
		});
	}
}

function pendingOutputState(runtime: TerminalRuntime): TerminalOutputQueueState {
	if (runtime.resyncFailed) return "failed";
	if (runtime.resyncRequired) return "resync";
	if (
		runtime.expectedSequence !== null &&
		!runtime.resyncing &&
		runtime.pendingChunks.size > 0 &&
		!runtime.pendingChunks.has(runtime.expectedSequence)
	) {
		return "gap";
	}
	return "ready";
}

export function queueTerminalOutput(
	runtime: TerminalRuntime,
	chunk: TerminalOutputChunk,
	onError: (error: unknown) => void,
): TerminalOutputQueueState {
	if (runtime.resyncFailed) return "failed";
	if (
		runtime.disposed ||
		chunk.terminalId !== runtime.snapshot.id ||
		chunk.generation !== runtime.snapshot.generation ||
		(runtime.expectedSequence !== null && chunk.sequence < runtime.expectedSequence)
	) {
		return pendingOutputState(runtime);
	}
	const existing = runtime.pendingChunks.get(chunk.sequence);
	if (!existing || (chunk.ackRequired && !existing.ackRequired)) {
		if (existing) runtime.pendingChunkChars -= existing.data.length;
		runtime.pendingChunks.set(chunk.sequence, chunk);
		runtime.pendingChunkChars += chunk.data.length;
	}
	if (runtime.pendingChunkChars > PENDING_OUTPUT_MAX_CHARS || runtime.pendingChunks.size > PENDING_OUTPUT_MAX_CHUNKS) {
		runtime.pendingChunks.clear();
		runtime.pendingChunkChars = 0;
		runtime.resyncRequired = true;
		return "resync";
	}
	drainOutput(runtime, onError);
	return pendingOutputState(runtime);
}

function assertMatchingAttachment(runtime: TerminalRuntime, attachment: TerminalAttachResult): void {
	if (
		attachment.snapshot.id !== runtime.snapshot.id ||
		attachment.snapshot.generation !== runtime.snapshot.generation
	) {
		throw new Error("Terminal replay belongs to a different runtime generation.");
	}
}

function applyTerminalAttachment(
	runtime: TerminalRuntime,
	attachment: TerminalAttachResult,
	resetXterm: boolean,
	onError: (error: unknown) => void,
): TerminalOutputQueueState {
	assertMatchingAttachment(runtime, attachment);
	const replayBoundary = attachment.nextSequence;
	const liveChunks = [...runtime.pendingChunks.values()]
		.filter((chunk) => chunk.sequence >= replayBoundary)
		.sort((left, right) => left.sequence - right.sequence);
	const followUpRequired = runtime.resyncRequired;
	runtime.pendingChunks.clear();
	runtime.pendingChunkChars = 0;
	runtime.snapshot = attachment.snapshot;
	runtime.replayTruncated = attachment.truncated;
	runtime.expectedSequence = attachment.chunks[0]?.sequence ?? replayBoundary;
	runtime.resyncing = false;
	runtime.resyncRequired = followUpRequired;
	if (resetXterm) runtime.xterm.reset();

	let state: TerminalOutputQueueState = followUpRequired ? "resync" : "ready";
	for (const chunk of [...attachment.chunks, ...liveChunks].sort((left, right) => left.sequence - right.sequence)) {
		const queued = queueTerminalOutput(runtime, chunk, onError);
		if (queued === "resync" || (queued === "gap" && state === "ready")) state = queued;
	}
	return state;
}

export function hydrateTerminalRuntime(
	runtime: TerminalRuntime,
	attachment: TerminalAttachResult,
	onError: (error: unknown) => void,
): TerminalOutputQueueState {
	return applyTerminalAttachment(runtime, attachment, false, onError);
}

export function beginTerminalRuntimeResync(runtime: TerminalRuntime): boolean {
	if (runtime.disposed || runtime.resyncFailed) return false;
	runtime.resyncing = true;
	runtime.resyncRequired = false;
	runtime.resyncAttempts += 1;
	return true;
}

export function replaceTerminalRuntimeReplay(
	runtime: TerminalRuntime,
	attachment: TerminalAttachResult,
	onError: (error: unknown) => void,
): TerminalOutputQueueState {
	return applyTerminalAttachment(runtime, attachment, true, onError);
}

export function cancelTerminalRuntimeResync(runtime: TerminalRuntime): void {
	runtime.resyncing = false;
	runtime.resyncRequired = false;
	runtime.pendingChunks.clear();
	runtime.pendingChunkChars = 0;
}

export function completeTerminalRuntimeResync(runtime: TerminalRuntime): void {
	runtime.resyncAttempts = 0;
	runtime.resyncFailed = false;
	if (runtime.resyncRetryTimer !== null) window.clearTimeout(runtime.resyncRetryTimer);
	runtime.resyncRetryTimer = null;
}

export function failTerminalRuntimeResync(runtime: TerminalRuntime): void {
	cancelTerminalRuntimeResync(runtime);
	if (runtime.resyncRetryTimer !== null) window.clearTimeout(runtime.resyncRetryTimer);
	runtime.resyncRetryTimer = null;
	runtime.resyncFailed = true;
}

/** A deliberate focus action is the recovery boundary after automatic retries stop. */
export function resetTerminalRuntimeResyncFailure(runtime: TerminalRuntime): boolean {
	if (!runtime.resyncFailed || runtime.disposed) return false;
	runtime.resyncFailed = false;
	runtime.resyncAttempts = 0;
	return true;
}

function cleanTerminalTitle(title: string): string {
	let clean = "";
	for (let index = 0; index < title.length; index += 1) {
		const code = title.charCodeAt(index);
		if (code >= 32 && (code < 127 || code > 159)) clean += title[index];
	}
	return clean.trim().slice(0, 256);
}

export function createTerminalRuntime(
	createEmulator: typeof createTerminalEmulator,
	api: TerminalRuntime["api"],
	openExternal: LingApi["app"]["openExternal"],
	snapshot: TerminalSnapshot,
	onError: (error: unknown) => void,
	onUpdate: () => void,
	typography: TerminalTypography,
): TerminalRuntime {
	const { xterm, fitAddon, searchAddon } = createEmulator(openExternal, xtermTheme(), onError, typography);
	const runtime: TerminalRuntime = {
		api,
		snapshot,
		title: snapshot.profileName,
		xterm,
		fitAddon,
		searchAddon,
		opened: false,
		replayTruncated: false,
		disposed: false,
		expectedSequence: null,
		pendingChunks: new Map(),
		pendingChunkChars: 0,
		resyncing: false,
		resyncRequired: false,
		resyncAttempts: 0,
		resyncRetryTimer: null,
		resyncFailed: false,
		inputBuffer: "",
		inputQueuedChars: 0,
		inputQueuedOperations: 0,
		inputCapacityErrorReported: false,
		inputTimer: null,
		inputTail: Promise.resolve(),
		lastSentCols: 0,
		lastSentRows: 0,
		disposables: [],
	};
	runtime.disposables.push(
		xterm.onData((data) => enqueueInput(runtime, data, onError)),
		xterm.onTitleChange((title) => {
			const normalized = cleanTerminalTitle(title);
			if (!normalized || normalized === runtime.title) return;
			runtime.title = normalized;
			onUpdate();
		}),
	);
	xterm.attachCustomKeyEventHandler((event) => {
		if (event.type !== "keydown") return true;
		const key = event.key.toLowerCase();
		const copyOrPasteShortcut =
			appPlatform === "darwin"
				? event.metaKey && !event.ctrlKey && !event.altKey
				: appPlatform === "win32"
					? event.ctrlKey && !event.metaKey && !event.altKey
					: event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
		if (key === "c" && copyOrPasteShortcut && xterm.hasSelection()) {
			event.preventDefault();
			void navigator.clipboard.writeText(xterm.getSelection()).catch(onError);
			return false;
		}
		if (key === "v" && copyOrPasteShortcut) {
			event.preventDefault();
			void navigator.clipboard
				.readText()
				.then((text) => xterm.paste(text))
				.catch(onError);
			return false;
		}
		const searchShortcut =
			appPlatform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey && !event.shiftKey;
		if (key === "f" && searchShortcut && !event.altKey) {
			event.preventDefault();
			return false;
		}
		return true;
	});
	return runtime;
}

export function disposeTerminalRuntime(
	runtime: TerminalRuntime,
	flushPendingInput: boolean,
	onError: (error: unknown) => void,
): void {
	if (runtime.disposed) return;
	if (flushPendingInput && runtime.snapshot.status === "running") flushInput(runtime, onError);
	else {
		if (runtime.inputTimer !== null) window.clearTimeout(runtime.inputTimer);
		runtime.inputTimer = null;
		runtime.inputQueuedChars = Math.max(0, runtime.inputQueuedChars - runtime.inputBuffer.length);
		runtime.inputBuffer = "";
	}
	runtime.disposed = true;
	if (runtime.resyncRetryTimer !== null) window.clearTimeout(runtime.resyncRetryTimer);
	runtime.resyncRetryTimer = null;
	runtime.pendingChunks.clear();
	runtime.pendingChunkChars = 0;
	for (const disposable of runtime.disposables) disposable.dispose();
	runtime.disposables = [];
	runtime.xterm.element?.remove();
	runtime.xterm.dispose();
}

export function fitTerminalRuntime(runtime: TerminalRuntime, onError: (error: unknown) => void): void {
	if (runtime.disposed || !runtime.opened) return;
	runtime.fitAddon.fit();
	if (runtime.snapshot.status !== "running") return;
	const cols = Math.max(2, runtime.xterm.cols);
	const rows = Math.max(1, runtime.xterm.rows);
	if (runtime.lastSentCols === cols && runtime.lastSentRows === rows) return;
	runtime.lastSentCols = cols;
	runtime.lastSentRows = rows;
	void runtime.api.resize({ ...terminalRef(runtime.snapshot), cols, rows }).catch(onError);
}

export function mountTerminalRuntime(
	runtime: TerminalRuntime,
	container: HTMLElement,
	onError: (error: unknown) => void,
): () => void {
	if (!runtime.opened) {
		runtime.xterm.open(container);
		runtime.opened = true;
	} else if (runtime.xterm.element && runtime.xterm.element.parentElement !== container) {
		container.appendChild(runtime.xterm.element);
		runtime.xterm.refresh(0, runtime.xterm.rows - 1);
	}
	queueMicrotask(() => {
		if (runtime.disposed || !container.isConnected) return;
		fitTerminalRuntime(runtime, onError);
	});
	return () => {
		if (runtime.xterm.element?.parentElement === container) runtime.xterm.element.remove();
	};
}

export function updateTerminalRuntimeTheme(runtime: TerminalRuntime): void {
	runtime.xterm.options.theme = xtermTheme();
}
