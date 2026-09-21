import type {
	TerminalAckRequest,
	TerminalAttachResult,
	TerminalCreateRequest,
	TerminalEvent,
	TerminalInputRequest,
	TerminalOutputChunk,
	TerminalProfilesSnapshot,
	TerminalRefRequest,
	TerminalResizeRequest,
	TerminalSnapshot,
} from "@ling/contracts/terminal";
import { terminalProcedures } from "@ling/contracts/terminal-procedures";
import { requestCapacityExceeded, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { AppSettingsStore } from "@ling/host/domains/settings/app-settings";
import { sanitizeChildProcessEnvironment } from "@ling/host/runtime/child-process-environment";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import { terminalKey } from "@ling/host/workers/terminal/terminal-host-protocol";
import type { ChildProcess } from "node:child_process";
import { type HostWorkerProcess, spawnHostWorkerProcess } from "../../workers/host-worker-process";
import { randomUUID } from "node:crypto";
import {
	TERMINAL_HOST_FRAME_MAX_BYTES,
	terminalHostEventSchema,
	terminalHostInputSchema,
	terminalHostPidSchema,
	terminalHostRequestSchema,
	type TerminalHostInput,
	type TerminalHostRequest,
} from "../../workers/terminal/terminal-host-protocol";
import { createWorkerRpc, postWorkerMessage } from "../../workers/worker-rpc";
import { detectTerminalProfiles, resolveTerminalProfile } from "./terminal-profiles";

const log = createLogger("terminal-service");
/**
 * Per-terminal replay buffer character cap. ~1M chars covers long scrollback; beyond it
 * the oldest chunks drop so an attach does not serialize the whole history into the
 * renderer and blow up memory. Only acked chunks are evicted, so unrendered output is never lost.
 */
const REPLAY_MAX_CHARS_PER_TERMINAL = 1_000_000;
/**
 * Hard cap: includes un-acked output. When the renderer is stuck or not attached the soft
 * cap cannot advance; without this hard cap the buffer grows without bound. 2× soft leaves
 * room for brief backpressure; higher only inflates main-process RSS.
 */
const REPLAY_HARD_MAX_CHARS_PER_TERMINAL = 2_000_000;
/** Character caps alone still permit millions of tiny chunk objects. */
const REPLAY_MAX_CHUNKS_PER_TERMINAL = 4_096;
const REPLAY_HARD_MAX_CHUNKS_PER_TERMINAL = 8_192;
/** Timeout for terminal-host replies to spawn/resize etc; 10s covers a cold start — past that, fail visibly instead of hanging forever. */
const HOST_REQUEST_TIMEOUT_MS = 10_000;
/** Response promises each retain a timer and command context until host settlement. */
const HOST_REQUEST_CAPACITY = 128;
/** Max integrated terminals per project; 16 covers multi-tab use — more only inflates PTY/replay-buffer footprint. */
const MAX_TERMINALS_PER_PROJECT = 16;
/** Process-wide terminal cap; 64 stops cross-project tab sprawl from dragging down the main process and host. */
const MAX_TERMINALS_TOTAL = 64;

interface StoredOutput {
	chunk: TerminalOutputChunk;
	acknowledged: boolean;
}

interface TerminalRecord {
	snapshot: TerminalSnapshot;
	output: StoredOutput[];
	outputBySequence: Map<number, StoredOutput>;
	outputChars: number;
	truncated: boolean;
	nextSequence: number;
}

type TerminalRpc = ReturnType<typeof createWorkerRpc<TerminalHostRequest, number | null, TerminalHostInput>>;

interface TerminalService {
	listProfiles(): Promise<TerminalProfilesSnapshot>;
	list(): TerminalSnapshot[];
	create(request: TerminalCreateRequest & { cwd: string }): Promise<TerminalSnapshot>;
	attach(request: TerminalRefRequest): TerminalAttachResult;
	input(request: TerminalInputRequest): Promise<void>;
	resize(request: TerminalResizeRequest): Promise<void>;
	ack(request: TerminalAckRequest): Promise<void>;
	close(request: TerminalRefRequest): Promise<void>;
	closeProject(cwd: string): Promise<void>;
	dispose(): Promise<void>;
}

function copySnapshot(snapshot: TerminalSnapshot): TerminalSnapshot {
	return {
		...snapshot,
		exit: snapshot.exit === null ? null : { ...snapshot.exit },
	};
}

function copyChunk(chunk: TerminalOutputChunk, ackRequired: boolean): TerminalOutputChunk {
	return { ...chunk, ackRequired };
}

export function createTerminalService(
	events: HostEventPublisher,
	settingsStore: Pick<AppSettingsStore, "getAppSettings" | "readAppSettings">,
): TerminalService {
	const records = new Map<string, TerminalRecord>();
	let rpc: TerminalRpc | null = null;
	const closeOperations = new Map<string, Promise<void>>();
	const pendingCreatesByProject = new Map<string, number>();
	let pendingCreateCount = 0;
	let child: ChildProcess | null = null;
	const workers = new WeakMap<ChildProcess, HostWorkerProcess>();
	const retiringHosts = new Set<Promise<void>>();
	let nextGeneration = 1;
	let disposePromise: Promise<void> | null = null;
	let disposing = false;

	const emit = (event: TerminalEvent): void => {
		events.broadcast(terminalProcedures.onEvent.channel, event);
	};

	const recordFor = (request: TerminalRefRequest): TerminalRecord => {
		const record = records.get(terminalKey(request.terminalId, request.generation));
		if (!record) throw new Error("Terminal is no longer available.");
		return record;
	};

	const rejectPending = (error: Error): void => {
		rpc?.close(error);
	};

	const markHostLost = (): void => {
		for (const record of records.values()) {
			if (record.snapshot.status !== "running") continue;
			record.snapshot = {
				...record.snapshot,
				status: "exited",
				exit: { exitCode: null, signal: null, reason: "hostLost" },
			};
			emit({ type: "exit", snapshot: copySnapshot(record.snapshot) });
		}
	};

	const dropOldestOutput = (record: TerminalRecord): boolean => {
		const first = record.output[0];
		if (!first) return false;
		record.output.shift();
		record.outputBySequence.delete(first.chunk.sequence);
		record.outputChars -= first.chunk.data.length;
		record.truncated = true;
		return true;
	};

	const trimReplay = (record: TerminalRecord): void => {
		// Soft cap: only drop acknowledged chunks so in-flight render never loses data.
		while (
			record.outputChars > REPLAY_MAX_CHARS_PER_TERMINAL ||
			record.output.length > REPLAY_MAX_CHUNKS_PER_TERMINAL
		) {
			const first = record.output[0];
			if (!first?.acknowledged) break;
			if (!dropOldestOutput(record)) break;
		}
		// Hard cap: force-drop even unacked backlog when the consumer is stalled.
		while (
			record.outputChars > REPLAY_HARD_MAX_CHARS_PER_TERMINAL ||
			record.output.length > REPLAY_HARD_MAX_CHUNKS_PER_TERMINAL
		) {
			if (!dropOldestOutput(record)) break;
		}
	};

	const handleHostMessage = (source: ChildProcess, value: unknown): void => {
		// An idle host may finish exiting after its replacement has spawned. Ignore every
		// late message from the detached generation so it cannot settle new-host requests.
		if (source !== child) return;
		const message = terminalHostEventSchema.parse(value);
		if (message.kind === "idle") {
			if (disposing || records.size > 0 || pendingCreateCount > 0 || (rpc?.size ?? 0) > 0 || closeOperations.size > 0) {
				return;
			}
			child = null;
			rpc?.close(new Error("Terminal host is idle."));
			rpc = null;
			const stopping = terminateHost(source).catch((error: unknown) => {
				log.error("failed to stop idle terminal host:", error);
			});
			const tracked: Promise<void> = stopping.finally(() => retiringHosts.delete(tracked));
			retiringHosts.add(tracked);
			return;
		}

		const key = terminalKey(message.terminalId, message.generation);
		const record = records.get(key);
		if (!record) return;
		if (message.kind === "output") {
			const chunk: TerminalOutputChunk = {
				terminalId: message.terminalId,
				generation: message.generation,
				sequence: message.sequence,
				data: message.data,
				ackUnits: message.ackUnits,
				ackRequired: true,
			};
			const stored = { chunk, acknowledged: false };
			record.output.push(stored);
			record.outputBySequence.set(chunk.sequence, stored);
			record.outputChars += chunk.data.length;
			record.nextSequence = Math.max(record.nextSequence, chunk.sequence + 1);
			trimReplay(record);
			emit({ type: "output", chunk: copyChunk(chunk, true) });
			return;
		}
		record.snapshot = { ...record.snapshot, status: "exited", exit: { ...message.exit } };
		emit({ type: "exit", snapshot: copySnapshot(record.snapshot) });
	};

	const ensureHost = (): ChildProcess => {
		if (child) return child;
		if (disposing) throw new Error("Terminal service is shutting down.");
		const worker = spawnHostWorkerProcess({
			entry: "terminal-host-entry.js",
			label: "terminal",
			env: sanitizeChildProcessEnvironment(),
		});
		const spawned = worker.child;
		workers.set(spawned, worker);
		child = spawned;
		const spawnedRpc = createWorkerRpc<TerminalHostRequest, number | null, TerminalHostInput>({
			capacity: HOST_REQUEST_CAPACITY,
			capacityError: () =>
				requestCapacityExceeded(
					"terminalHostRequest",
					HOST_REQUEST_CAPACITY,
					"The terminal host request backlog is full. Wait for an active terminal operation to finish, then retry.",
				),
			maxFrameBytes: TERMINAL_HOST_FRAME_MAX_BYTES,
			post: (value) => postWorkerMessage(spawned, value),
			onMessage(listener) {
				spawned.on("message", listener);
				return () => {
					spawned.off("message", listener);
				};
			},
			receiveEvent: (value) => handleHostMessage(spawned, value),
			parseResponse: (value) => terminalHostPidSchema.parse(value),
			onError: (error) => log.error("terminal host RPC failed:", error),
		});
		rpc = spawnedRpc;
		const lose = (error: Error): void => {
			spawnedRpc.close(error);
			if (child !== spawned) return;
			child = null;
			rejectPending(error);
			if (!disposing) {
				log.error(error.message);
				markHostLost();
			}
		};
		spawned.once("exit", (code) =>
			lose(new Error(`Terminal host exited${code === null ? "" : ` with code ${code}`}.`)),
		);
		// A process that never started emits no exit event.
		spawned.once("error", (error) => {
			if (spawned.pid === undefined) lose(new Error(`Terminal host could not start: ${error.message}`));
		});
		return spawned;
	};

	const requireRpc = (): TerminalRpc => {
		ensureHost();
		if (!rpc) throw new Error("Terminal host RPC was not initialized");
		return rpc;
	};
	const post = (command: TerminalHostInput): Promise<void> => requireRpc().emit(terminalHostInputSchema.parse(command));
	const requestHost = (command: TerminalHostRequest): Promise<number | null> =>
		requireRpc().call(terminalHostRequestSchema.parse(command), {
			context: undefined,
			deadline: {
				at: Date.now() + HOST_REQUEST_TIMEOUT_MS,
				error: () => new Error("Terminal host request timed out."),
			},
		});

	const reserveTerminalCreate = (cwd: string): (() => void) => {
		const projectRecords = [...records.values()].filter((record) => record.snapshot.cwd === cwd).length;
		const projectPending = pendingCreatesByProject.get(cwd) ?? 0;
		if (records.size + pendingCreateCount >= MAX_TERMINALS_TOTAL) {
			throw requestCapacityExceeded(
				"terminalInstance",
				MAX_TERMINALS_TOTAL,
				`Ling supports at most ${MAX_TERMINALS_TOTAL} terminal instances at once.`,
			);
		}
		if (projectRecords + projectPending >= MAX_TERMINALS_PER_PROJECT) {
			throw requestCapacityExceeded(
				"projectTerminalInstance",
				MAX_TERMINALS_PER_PROJECT,
				`A project supports at most ${MAX_TERMINALS_PER_PROJECT} terminal instances at once.`,
			);
		}
		pendingCreateCount += 1;
		pendingCreatesByProject.set(cwd, projectPending + 1);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			pendingCreateCount -= 1;
			const remaining = (pendingCreatesByProject.get(cwd) ?? 1) - 1;
			if (remaining === 0) pendingCreatesByProject.delete(cwd);
			else pendingCreatesByProject.set(cwd, remaining);
		};
	};

	const closeRecord = (record: TerminalRecord): Promise<void> => {
		const key = terminalKey(record.snapshot.id, record.snapshot.generation);
		const existing = closeOperations.get(key);
		if (existing) return existing;
		const operation = (async () => {
			if (record.snapshot.status === "running" && child) {
				await requestHost({
					kind: "close",
					terminalId: record.snapshot.id,
					generation: record.snapshot.generation,
				});
			}
			if (records.get(key) !== record) return;
			records.delete(key);
			emit({
				type: "removed",
				ref: { terminalId: record.snapshot.id, generation: record.snapshot.generation },
			});
		})().finally(() => closeOperations.delete(key));
		closeOperations.set(key, operation);
		return operation;
	};

	const terminateHost = (target: ChildProcess): Promise<void> => workers.get(target)?.terminate() ?? Promise.resolve();

	return {
		listProfiles: async () => {
			const snapshot = await detectTerminalProfiles();
			const settings = settingsStore.readAppSettings();
			return {
				...snapshot,
				configuredProfileId: settings.status === "ready" ? settings.settings.integratedTerminalProfileId : null,
			};
		},
		list: () =>
			[...records.values()]
				.map((record) => copySnapshot(record.snapshot))
				.sort((left, right) => left.createdAt - right.createdAt),
		create: async (request) => {
			const releaseReservation = reserveTerminalCreate(request.cwd);
			try {
				const configuredProfileId =
					request.profileId === undefined
						? settingsStore.getAppSettings().integratedTerminalProfileId
						: request.profileId;
				const profile = await resolveTerminalProfile(configuredProfileId);
				const terminalId = randomUUID();
				const generation = nextGeneration;
				nextGeneration += 1;
				const key = terminalKey(terminalId, generation);
				const provisional: TerminalRecord = {
					snapshot: {
						id: terminalId,
						cwd: request.cwd,
						profileId: profile.id,
						profileName: profile.name,
						pid: 0,
						createdAt: Date.now(),
						generation,
						status: "running",
						exit: null,
					},
					output: [],
					outputBySequence: new Map(),
					outputChars: 0,
					truncated: false,
					nextSequence: 1,
				};
				releaseReservation();
				records.set(key, provisional);
				try {
					const pid = await requestHost({
						kind: "create",
						terminalId,
						generation,
						cwd: request.cwd,
						shellPath: profile.path,
						args: [...profile.args],
						cols: request.cols,
						rows: request.rows,
					});
					if (pid === null) throw new Error("Terminal host did not return a process id.");
					provisional.snapshot = { ...provisional.snapshot, pid };
					return copySnapshot(provisional.snapshot);
				} catch (error) {
					if (records.get(key) === provisional) {
						records.delete(key);
						emit({ type: "removed", ref: { terminalId, generation } });
					}
					if (child) {
						try {
							await requestHost({
								kind: "close",
								terminalId,
								generation,
							});
						} catch (cleanupError) {
							log.error("failed to request cleanup for a provisional terminal:", cleanupError);
						}
					}
					throw error;
				}
			} finally {
				releaseReservation();
			}
		},
		attach: (request) => {
			const record = recordFor(request);
			return {
				snapshot: copySnapshot(record.snapshot),
				chunks: record.output.map(({ chunk, acknowledged }) => copyChunk(chunk, !acknowledged)),
				truncated: record.truncated,
				nextSequence: record.nextSequence,
			};
		},
		input: async (request) => {
			const record = recordFor(request);
			if (record.snapshot.status !== "running") throw new Error("Terminal process has exited.");
			await post({ kind: "input", ...request });
		},
		resize: async (request) => {
			// ResizeObserver callbacks and terminal-close IPC can cross in flight.
			// A resize for an already removed generation is harmless and must not
			// surface as a user-visible error after a successful close.
			const record = records.get(terminalKey(request.terminalId, request.generation));
			if (!record) return;
			if (record.snapshot.status !== "running") return;
			await post({ kind: "resize", ...request });
		},
		ack: async (request) => {
			// xterm invokes write callbacks asynchronously; a rendered chunk may be
			// acknowledged just after its terminal was closed and removed.
			const record = records.get(terminalKey(request.terminalId, request.generation));
			if (!record) return;
			const output = record.outputBySequence.get(request.sequence);
			if (!output) {
				if (request.sequence < record.nextSequence && record.truncated) return;
				throw new Error("Terminal output acknowledgement references an unknown sequence.");
			}
			if (output.chunk.ackUnits !== request.ackUnits) {
				throw new Error("Terminal output acknowledgement has an invalid size.");
			}
			if (output.acknowledged) return;
			output.acknowledged = true;
			if (record.snapshot.status === "running" && child) await post({ kind: "ack", ...request });
			trimReplay(record);
		},
		close: async (request) => {
			const record = records.get(terminalKey(request.terminalId, request.generation));
			if (record) await closeRecord(record);
		},
		closeProject: async (cwd) => {
			const projectRecords = [...records.values()].filter((record) => record.snapshot.cwd === cwd);
			const results = await Promise.allSettled(projectRecords.map(closeRecord));
			const errors = results
				.filter((result): result is PromiseRejectedResult => result.status === "rejected")
				.map((result) => toError(result.reason));
			if (errors.length > 0) throw new AggregateError(errors, `Failed to close terminals for ${cwd}`);
		},
		dispose: () => {
			if (disposePromise) return disposePromise;
			disposing = true;
			disposePromise = (async () => {
				const activeChild = child;
				if (!activeChild || workers.get(activeChild)?.exited() !== false) {
					records.clear();
					rejectPending(new Error("Terminal service has shut down."));
					await Promise.allSettled([...retiringHosts]);
					return;
				}
				try {
					await requestHost({ kind: "dispose" });
				} catch (error) {
					log.error("terminal host dispose request failed:", error);
				}
				try {
					await terminateHost(activeChild);
				} finally {
					records.clear();
					rejectPending(new Error("Terminal service has shut down."));
					await Promise.allSettled([...retiringHosts]);
				}
			})();
			return disposePromise;
		},
	};
}
