import { sessionKey } from "@ling/contracts/session-ref";
import { throwAggregateFailures } from "@ling/core/ling-error";
import type { PiWorkerCallMain } from "@ling/core/pi-protocol/callback-methods";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { controlSessionRefSchema, controlIdSchema as runtimeIdSchema } from "../../pi-protocol/control-schemas";
import { piLifecycleMethods } from "../../pi-protocol/lifecycle-methods";
import { isPiWorkerRuntimeMethod } from "../../pi-protocol/methods";
import type {
	PiWorkerEvent,
	PiWorkerRequest,
	PiWorkerRuntimeBootstrap,
	PiWorkerRuntimeSnapshotResult,
	PiWorkerRuntimeStateSnapshotResult,
} from "../../pi-protocol/protocol";
import type { parsePiWorkerSessionRef } from "../../pi-protocol/protocol-validation";
import { piRuntimeMethods } from "../../pi-protocol/runtime-methods";
import type { PiExtensionUi } from "../extensions/extension-ui-context";
import type { PiProjectServices } from "../projects/services";
import type { PiSessionRuntimes } from "../session/runtime-entrypoints";
import type { PiSessionRuntimeHandle } from "../session/runtime";
import { createPiWorkerDialogBridge, type PiWorkerDialogContext } from "./pi-worker-dialog-bridge";
import { dispatchPiWorkerRuntimeCall } from "./pi-worker-runtime-dispatch";
import { createPiWorkerRuntimeRegistry } from "./pi-worker-runtime-registry";

export interface PiWorkerRuntimeService {
	handle(request: PiWorkerRequest, signal: AbortSignal): Promise<unknown>;
	cancelCompletedLifecycle(request: PiWorkerRequest): Promise<void>;
	disposeProjectRuntimes(cwd: string): Promise<void>;
	refreshSettings(): Promise<void>;
	dispose(): Promise<void>;
}

interface RuntimeServiceOptions {
	projects: PiProjectServices;
	runtimes: PiSessionRuntimes;
	extensionUi: PiExtensionUi;
	generation: number;
	callMain: PiWorkerCallMain;
	emit(event: PiWorkerEvent): void;
	onFatal(error: Error): void;
}

const recordSchema = z.record(z.string().max(256), z.unknown());

function runtimeParams(value: unknown): {
	runtimeId: string;
	ref: ReturnType<typeof parsePiWorkerSessionRef>;
	args: Record<string, unknown>;
} {
	const parsed = z
		.strictObject({ runtimeId: runtimeIdSchema, ref: controlSessionRefSchema, args: recordSchema.optional() })
		.parse(value);
	return {
		runtimeId: parsed.runtimeId,
		ref: parsed.ref,
		args: parsed.args ?? {},
	};
}

function staleRuntimeGeneration(runtimeId: string): Error {
	return Object.assign(new Error(`Pi runtime identity changed before the request was handled: ${runtimeId}`), {
		code: "STALE_RUNTIME_GENERATION" as const,
		retryable: true,
		category: "lifecycle" as const,
		userAction: "retry" as const,
	});
}

async function disposeRuntimeWithSessionRollback(
	runtime: SessionRuntimePort,
	dispose: () => Promise<void>,
	rollbackSessionFile: string | undefined,
): Promise<void> {
	const failures: unknown[] = [];
	try {
		await dispose();
	} catch (error) {
		failures.push(error);
	}
	if (rollbackSessionFile) {
		try {
			await rm(rollbackSessionFile, { force: true });
		} catch (error) {
			failures.push(error);
		}
	}
	throwAggregateFailures(failures, `Failed to dispose unattached Pi runtime ${runtime.sessionId}`);
}

export function createPiWorkerRuntimeService(options: RuntimeServiceOptions): PiWorkerRuntimeService {
	const { createPiSessionRuntime, forkPiSessionRuntime, resumePiSessionRuntime } = options.runtimes;
	const { getPiServices, listOpenProjectPaths, openProject } = options.projects;

	const dialogBridge = createPiWorkerDialogBridge(options.callMain, options.extensionUi.bridge);
	const registry = createPiWorkerRuntimeRegistry({
		extensionUi: options.extensionUi,
		generation: options.generation,
		callMain: options.callMain,
		emit: options.emit,
		onFatal: options.onFatal,
		dialogBridge,
	});

	const ensureProject = async (cwd: string): Promise<string> => {
		if (listOpenProjectPaths().includes(cwd)) return getPiServices(cwd).cwd;
		return (await openProject(cwd)).cwd;
	};

	const attachCreatedRuntime = async (
		request: PiWorkerRequest,
		runtimeId: string,
		signal: AbortSignal,
		sessionFileOwnership: "new" | "existing",
		create: (dialogs: PiWorkerDialogContext) => Promise<PiSessionRuntimeHandle>,
	): Promise<PiWorkerRuntimeBootstrap> => {
		const dialogs = dialogBridge.create(runtimeId, request.requestId, signal);
		let runtime: PiSessionRuntimeHandle | null = null;
		let rollbackSessionFile: string | undefined;
		try {
			if (signal.aborted) throw signal.reason ?? new Error("Pi worker runtime creation was cancelled");
			runtime = await create(dialogs);
			rollbackSessionFile = sessionFileOwnership === "new" ? runtime.sessionFile : undefined;
			if (signal.aborted) throw signal.reason ?? new Error("Pi worker runtime creation was cancelled");
			const bootstrap = await registry.attach(runtimeId, runtime, dialogs, rollbackSessionFile ?? null);
			if (signal.aborted) {
				throw signal.reason ?? new Error("Pi worker runtime creation was cancelled");
			}
			return bootstrap;
		} catch (error) {
			const failures: unknown[] = [error];
			if (runtime) {
				const createdRuntime = runtime;
				const record = registry.get(runtimeId);
				try {
					await disposeRuntimeWithSessionRollback(
						createdRuntime,
						record?.runtime === createdRuntime ? () => registry.disposeRuntime(record) : () => createdRuntime.dispose(),
						rollbackSessionFile,
					);
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			try {
				dialogBridge.releaseAll(dialogs);
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			throwAggregateFailures(failures, `Failed to create Pi runtime ${runtimeId}`);
			throw new Error("Unreachable Pi runtime creation cleanup");
		}
	};

	const handleCreate = async (request: PiWorkerRequest, signal: AbortSignal): Promise<PiWorkerRuntimeBootstrap> => {
		const parsed = piLifecycleMethods["runtime.create"].input.parse(request.params);
		if (signal.aborted) throw signal.reason;
		const cwd = await ensureProject(parsed.cwd);
		return attachCreatedRuntime(request, parsed.runtimeId, signal, "new", (dialogs) =>
			createPiSessionRuntime(cwd, {
				beforeBind: (ref) => dialogBridge.beforeBind(dialogs, ref),
				...(parsed.model === undefined ? {} : { model: parsed.model }),
				...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
			}),
		);
	};

	const handleResume = async (request: PiWorkerRequest, signal: AbortSignal): Promise<PiWorkerRuntimeBootstrap> => {
		const parsed = piLifecycleMethods["runtime.resume"].input.parse(request.params);
		if (signal.aborted) throw signal.reason;
		const cwd = await ensureProject(parsed.cwd);
		const sessionFilePath = parsed.sessionFilePath;
		return attachCreatedRuntime(request, parsed.runtimeId, signal, "existing", (dialogs) =>
			resumePiSessionRuntime(cwd, sessionFilePath, parsed.createdAt, {
				beforeBind: (ref) => dialogBridge.beforeBind(dialogs, ref),
			}),
		);
	};

	const handleFork = async (request: PiWorkerRequest, signal: AbortSignal): Promise<PiWorkerRuntimeBootstrap> => {
		const parsed = piLifecycleMethods["runtime.fork"].input.parse(request.params);
		if (signal.aborted) throw signal.reason;
		const cwd = await ensureProject(parsed.cwd);
		return attachCreatedRuntime(request, parsed.runtimeId, signal, "new", (dialogs) =>
			forkPiSessionRuntime({ cwd, sessionFile: parsed.sourceSessionFilePath }, parsed.entryId, parsed.title, {
				beforeBind: (ref) => dialogBridge.beforeBind(dialogs, ref),
			}),
		);
	};

	const handle = async (request: PiWorkerRequest, signal: AbortSignal): Promise<unknown> => {
		registry.assertAccepting();
		switch (request.method) {
			case "runtime.create":
				return handleCreate(request, signal);
			case "runtime.resume":
				return handleResume(request, signal);
			case "runtime.fork":
				return handleFork(request, signal);
			default: {
				if (!isPiWorkerRuntimeMethod(request.method)) {
					throw new Error(`Pi worker runtime service received a domain method: ${request.method}`);
				}
				const { runtimeId, ref, args } = runtimeParams(request.params);
				const record = registry.require(runtimeId);
				if (sessionKey(record.runtime.ref) !== sessionKey(ref)) throw staleRuntimeGeneration(runtimeId);
				if (request.method === "runtime.getStateSnapshot" || request.method === "runtime.getSnapshot") {
					piRuntimeMethods[request.method].input.parse(args);
					if (signal.aborted) throw signal.reason;
					const read =
						request.method === "runtime.getSnapshot"
							? () => record.runtime.getSnapshot()
							: () => record.runtime.getStateSnapshot();
					const captured = await record.delivery.capture(async () => {
						if (sessionKey(record.runtime.ref) !== sessionKey(ref)) throw staleRuntimeGeneration(runtimeId);
						const snapshotPromise = read();
						const snapshotRef = { ...record.runtime.ref };
						const snapshot = await snapshotPromise;
						if (sessionKey(record.runtime.ref) !== sessionKey(snapshotRef)) {
							throw staleRuntimeGeneration(runtimeId);
						}
						return { ref: snapshotRef, snapshot };
					});
					if (signal.aborted) throw signal.reason;
					if (
						sessionKey(captured.result.ref) !== sessionKey(ref) ||
						sessionKey(record.runtime.ref) !== sessionKey(ref)
					) {
						throw staleRuntimeGeneration(runtimeId);
					}
					return {
						ref: captured.result.ref,
						snapshot: captured.result.snapshot,
						eventSequence: captured.eventSequence,
					} satisfies PiWorkerRuntimeStateSnapshotResult | PiWorkerRuntimeSnapshotResult;
				}
				try {
					return await dispatchPiWorkerRuntimeCall({
						method: request.method,
						args,
						runtime: record.runtime,
						signal,
						dispose: (shouldRollbackSessionFile) =>
							disposeRuntimeWithSessionRollback(
								record.runtime,
								() => registry.disposeRuntime(record),
								shouldRollbackSessionFile ? (record.rollbackSessionFile ?? undefined) : undefined,
							),
					});
				} finally {
					await record.delivery.waitForDelivery();
				}
			}
		}
	};

	return {
		handle,
		async cancelCompletedLifecycle(request) {
			if (
				request.method !== "runtime.create" &&
				request.method !== "runtime.resume" &&
				request.method !== "runtime.fork"
			) {
				return;
			}
			const params = z.strictObject({ runtimeId: runtimeIdSchema }).loose().parse(request.params);
			const record = registry.get(params.runtimeId);
			if (record) {
				await disposeRuntimeWithSessionRollback(
					record.runtime,
					() => registry.disposeRuntime(record),
					record.rollbackSessionFile ?? undefined,
				);
			}
		},
		disposeProjectRuntimes: registry.disposeProjectRuntimes,
		refreshSettings: registry.refreshSettings,
		dispose: registry.dispose,
	};
}
