import { errorMessage } from "@ling/contracts/ling-error";
import { TERMINAL_OUTPUT_CHUNK_MAX_CHARS, type TerminalExitInfo } from "@ling/contracts/terminal";
import { toError } from "@ling/core/ling-error";
import { terminalKey } from "@ling/host/workers/terminal/terminal-host-protocol";
import { terminateProcessTree } from "@ling/node-runtime/process-tree-terminator";
import { type IDisposable, type IPty, spawn } from "node-pty";
import { createWorkerRpc, postWorkerMessage } from "../worker-rpc";
import {
	TERMINAL_HOST_FRAME_MAX_BYTES,
	type TerminalHostInput,
	terminalHostInputSchema,
	type TerminalHostMessage,
	terminalHostPidSchema,
	type TerminalHostRequest,
	terminalHostRequestSchema,
} from "./terminal-host-protocol";

/**
 * High watermark for un-ACKed output chars. Past it, pause PTY reads so the host does not
 * back up without bound when the renderer falls behind. 100k chars is a few screens of
 * fast output — enough buffering without dragging down the terminal host.
 */
const HIGH_WATERMARK_UNACKED_CHARS = 100_000;
const HIGH_WATERMARK_UNACKED_CHUNKS = 256;
/**
 * Low watermark for un-ACKed output chars. Resume only once the backlog drops below it;
 * the gap against the high watermark avoids pause/resume flapping.
 */
const LOW_WATERMARK_UNACKED_CHARS = 5_000;
const LOW_WATERMARK_UNACKED_CHUNKS = 128;
/**
 * Output batching delay. Flush to the parent once per 8ms — fewer IPC calls while
 * interactions still feel fluid.
 */
const OUTPUT_BATCH_DELAY_MS = 8;
/** Paused PTYs can still deliver a short native backlog. Drain a normal burst first;
 * only an already-backpressured stream that remains above this emergency ceiling is
 * unrecoverable without dropping terminal output. */
const PENDING_OUTPUT_HARD_MAX_CHARS = 256_000;
const PENDING_OUTPUT_HARD_MAX_FRAGMENTS = 256;
const MAX_HOST_TERMINALS = 64;
/** Release the child process after a quiet zero-PTY window; a later create respawns it. */
const IDLE_HOST_ANNOUNCE_DELAY_MS = 30_000;

interface HostTerminal {
	id: string;
	generation: number;
	pty: IPty;
	outputDisposable: IDisposable;
	exitDisposable: IDisposable;
	pendingOutput: string[];
	pendingOutputChars: number;
	pendingAcks: Map<number, number>;
	unacknowledgedChars: number;
	nextSequence: number;
	flushTimer: NodeJS.Timeout | null;
	paused: boolean;
	closing: boolean;
	exited: boolean;
	pendingExit: TerminalExitInfo | null;
	finalized: boolean;
	termination: Promise<void> | null;
}

if (!process.send) throw new Error("terminal-host-entry requires a Node IPC channel");

const terminals = new Map<string, HostTerminal>();
let disposing = false;
let idleAnnouncementTimer: NodeJS.Timeout | null = null;

function post(message: TerminalHostMessage): void {
	void rpc.emit(message).catch((error: unknown) => console.error("[terminal-host] event delivery failed:", error));
}

function cancelIdleAnnouncement(): void {
	if (!idleAnnouncementTimer) return;
	clearTimeout(idleAnnouncementTimer);
	idleAnnouncementTimer = null;
}

function scheduleIdleAnnouncement(): void {
	if (disposing || terminals.size > 0 || idleAnnouncementTimer) return;
	idleAnnouncementTimer = setTimeout(() => {
		idleAnnouncementTimer = null;
		if (disposing || terminals.size > 0) return;
		post({ kind: "idle" });
		// If parent was racing a create and declined this announcement, try again
		// after another full idle window rather than retaining the host forever.
		scheduleIdleAnnouncement();
	}, IDLE_HOST_ANNOUNCE_DELAY_MS);
	idleAnnouncementTimer.unref();
}

function commandTerminal(command: { terminalId: string; generation: number }): HostTerminal {
	const terminal = terminals.get(terminalKey(command.terminalId, command.generation));
	if (!terminal) throw new Error("Terminal process is no longer available.");
	return terminal;
}

function processEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) environment[key] = value;
	}
	environment.TERM = "xterm-256color";
	environment.COLORTERM = "truecolor";
	environment.TERM_PROGRAM = "Ling";
	return environment;
}

function takeBoundedPrefix(terminal: HostTerminal): string {
	let remaining = TERMINAL_OUTPUT_CHUNK_MAX_CHARS;
	const parts: string[] = [];
	while (remaining > 0 && terminal.pendingOutput.length > 0) {
		const first = terminal.pendingOutput[0];
		if (first === undefined) break;
		if (first.length <= remaining) {
			parts.push(first);
			terminal.pendingOutput.shift();
			terminal.pendingOutputChars -= first.length;
			remaining -= first.length;
			continue;
		}
		let splitAt = remaining;
		const previous = first.charCodeAt(splitAt - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) splitAt -= 1;
		// The current chunk may have only one UTF-16 code unit left after
		// consuming earlier PTY fragments. Leave that slot unused instead of
		// splitting a surrogate pair; the next chunk starts with the full pair.
		if (splitAt === 0) break;
		parts.push(first.slice(0, splitAt));
		terminal.pendingOutput[0] = first.slice(splitAt);
		terminal.pendingOutputChars -= splitAt;
		remaining = 0;
	}
	return parts.join("");
}

function finalizeTerminalExit(terminal: HostTerminal): void {
	const exit = terminal.pendingExit;
	if (terminal.finalized || exit === null || terminal.pendingOutput.length > 0) return;
	terminal.finalized = true;
	terminal.pendingExit = null;
	removeTerminal(terminal);
	post({ kind: "exit", terminalId: terminal.id, generation: terminal.generation, exit });
}

function discardPendingOutput(terminal: HostTerminal): void {
	terminal.pendingOutput = [];
	terminal.pendingOutputChars = 0;
	terminal.pendingAcks.clear();
	terminal.unacknowledgedChars = 0;
	terminal.paused = false;
}

function flushOutput(terminal: HostTerminal): void {
	if (terminal.finalized) return;
	if (terminal.flushTimer) {
		clearTimeout(terminal.flushTimer);
		terminal.flushTimer = null;
	}
	while (terminal.pendingOutput.length > 0 && !terminal.paused) {
		const data = takeBoundedPrefix(terminal);
		if (data.length === 0) break;
		const sequence = terminal.nextSequence;
		terminal.nextSequence += 1;
		const ackUnits = data.length;
		terminal.pendingAcks.set(sequence, ackUnits);
		terminal.unacknowledgedChars += ackUnits;
		post({
			kind: "output",
			terminalId: terminal.id,
			generation: terminal.generation,
			sequence,
			data,
			ackUnits,
		});
		if (
			terminal.unacknowledgedChars > HIGH_WATERMARK_UNACKED_CHARS ||
			terminal.pendingAcks.size >= HIGH_WATERMARK_UNACKED_CHUNKS
		) {
			if (!terminal.exited) terminal.pty.pause();
			terminal.paused = true;
		}
	}
	finalizeTerminalExit(terminal);
}

function pendingOutputWouldOverflow(terminal: HostTerminal, data: string): boolean {
	return (
		terminal.pendingOutputChars + data.length > PENDING_OUTPUT_HARD_MAX_CHARS ||
		terminal.pendingOutput.length >= PENDING_OUTPUT_HARD_MAX_FRAGMENTS
	);
}

function scheduleOutput(terminal: HostTerminal, data: string): void {
	if (terminal.finalized || data.length === 0) return;
	if (pendingOutputWouldOverflow(terminal, data)) {
		// Fragment-heavy output can cross the object-count ceiling before the 8ms batch
		// timer fires. Give the normal ACK/backpressure path one synchronous drain before
		// treating the native backlog as unrecoverable.
		flushOutput(terminal);
	}
	if (terminal.finalized) return;
	if (pendingOutputWouldOverflow(terminal, data)) {
		if (!terminal.exited) terminal.pty.pause();
		terminal.paused = true;
		void killTerminal(terminal).catch((error: unknown) => {
			console.error("[terminal-host] output backlog termination failed:", errorMessage(error));
		});
		return;
	}
	terminal.pendingOutput.push(data);
	terminal.pendingOutputChars += data.length;
	if (terminal.pendingOutputChars >= TERMINAL_OUTPUT_CHUNK_MAX_CHARS) {
		flushOutput(terminal);
		return;
	}
	if (terminal.flushTimer) return;
	terminal.flushTimer = setTimeout(() => flushOutput(terminal), OUTPUT_BATCH_DELAY_MS);
}

function acknowledgeOutput(terminal: HostTerminal, sequence: number, ackUnits: number): void {
	const expected = terminal.pendingAcks.get(sequence);
	if (expected === undefined) return;
	if (expected !== ackUnits) throw new Error("Terminal output acknowledgement does not match the emitted chunk.");
	terminal.pendingAcks.delete(sequence);
	terminal.unacknowledgedChars = Math.max(0, terminal.unacknowledgedChars - ackUnits);
	if (
		terminal.paused &&
		terminal.unacknowledgedChars < LOW_WATERMARK_UNACKED_CHARS &&
		terminal.pendingAcks.size <= LOW_WATERMARK_UNACKED_CHUNKS
	) {
		if (!terminal.exited) terminal.pty.resume();
		terminal.paused = false;
		flushOutput(terminal);
	}
}

function removeTerminal(terminal: HostTerminal): void {
	terminals.delete(terminalKey(terminal.id, terminal.generation));
	if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
	terminal.flushTimer = null;
	terminal.outputDisposable.dispose();
	terminal.exitDisposable.dispose();
	scheduleIdleAnnouncement();
}

function emitExit(terminal: HostTerminal, exit: TerminalExitInfo): void {
	if (terminal.finalized) return;
	terminal.exited = true;
	terminal.pendingExit = exit;
	if (terminal.closing) discardPendingOutput(terminal);
	flushOutput(terminal);
}

function killTerminal(terminal: HostTerminal): Promise<void> {
	if (terminal.termination) return terminal.termination;
	terminal.closing = true;
	terminal.termination = (async () => {
		await terminateProcessTree({
			pid: terminal.pty.pid,
			terminateRoot: () => terminal.pty.kill(),
			rootExited: () => terminal.exited,
		});
		if (terminal.exited && !terminal.finalized) {
			discardPendingOutput(terminal);
			finalizeTerminalExit(terminal);
		}
	})();
	return terminal.termination;
}

function createTerminal(command: Extract<TerminalHostRequest, { kind: "create" }>): number {
	if (disposing) throw new Error("Terminal host is shutting down.");
	cancelIdleAnnouncement();
	if (terminals.size >= MAX_HOST_TERMINALS) throw new Error("Terminal host capacity is full.");
	const key = terminalKey(command.terminalId, command.generation);
	if (terminals.has(key)) throw new Error("Terminal id is already active.");
	const pty = spawn(command.shellPath, command.args, {
		name: "xterm-256color",
		cwd: command.cwd,
		cols: command.cols,
		rows: command.rows,
		env: processEnvironment(),
	});
	const terminal: HostTerminal = {
		id: command.terminalId,
		generation: command.generation,
		pty,
		outputDisposable: { dispose: () => undefined },
		exitDisposable: { dispose: () => undefined },
		pendingOutput: [],
		pendingOutputChars: 0,
		pendingAcks: new Map(),
		unacknowledgedChars: 0,
		nextSequence: 1,
		flushTimer: null,
		paused: false,
		closing: false,
		exited: false,
		pendingExit: null,
		finalized: false,
		termination: null,
	};
	terminal.outputDisposable = pty.onData((data) => scheduleOutput(terminal, data));
	terminal.exitDisposable = pty.onExit(({ exitCode, signal }) => {
		emitExit(terminal, {
			exitCode,
			signal: signal ?? null,
			reason: terminal.closing ? "killed" : "process",
		});
	});
	terminals.set(key, terminal);
	return pty.pid;
}

async function disposeAll(): Promise<void> {
	disposing = true;
	cancelIdleAnnouncement();
	const results = await Promise.allSettled([...terminals.values()].map(killTerminal));
	const errors = results
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => toError(result.reason));
	if (errors.length > 0) throw new AggregateError(errors, "Failed to terminate every terminal process tree.");
}

async function handleRequest(command: TerminalHostRequest): Promise<number | null> {
	if (command.kind === "create") {
		try {
			return createTerminal(command);
		} catch (error) {
			scheduleIdleAnnouncement();
			throw error;
		}
	}
	if (command.kind === "dispose") {
		await disposeAll();
		return null;
	}
	const terminal = terminals.get(terminalKey(command.terminalId, command.generation));
	// Closing a generation already removed by its exit event is idempotent.
	if (terminal) await killTerminal(terminal);
	return null;
}

function handleInput(command: TerminalHostInput): void {
	const terminal = commandTerminal(command);
	switch (command.kind) {
		case "input":
			terminal.pty.write(command.data);
			return;
		case "resize":
			terminal.pty.resize(command.cols, command.rows);
			return;
		case "ack":
			acknowledgeOutput(terminal, command.sequence, command.ackUnits);
			return;
	}
}

const rpc = createWorkerRpc<never, number | null, TerminalHostMessage>({
	// Terminal workers serve commands and output events; they do not initiate calls.
	capacity: 0,
	capacityError: () => new Error("Terminal worker cannot initiate requests"),
	maxFrameBytes: TERMINAL_HOST_FRAME_MAX_BYTES,
	post: (value) => postWorkerMessage(process, value),
	onMessage(listener) {
		process.on("message", listener);
		return () => {
			process.off("message", listener);
		};
	},
	receiveRequest: (value) => handleRequest(terminalHostRequestSchema.parse(value)),
	receiveEvent(value) {
		try {
			handleInput(terminalHostInputSchema.parse(value));
		} catch (error) {
			console.error("[terminal-host] command failed:", errorMessage(error));
		}
	},
	parseResponse: (value) => terminalHostPidSchema.parse(value),
	onError: (error) => console.error("[terminal-host] RPC failed:", error),
});
let shutdown: Promise<void> | null = null;
function stop(): void {
	shutdown ??= disposeAll().then(
		() => {
			rpc.close(new Error("Terminal worker stopped"));
			process.exit(0);
		},
		(error: unknown) => {
			console.error("[terminal-host] shutdown failed:", error);
			process.exit(1);
		},
	);
	void shutdown;
}
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
