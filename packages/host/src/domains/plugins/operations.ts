import { requestCancelled } from "@ling/core/ling-error";
import type {
	CancelPluginOperationRequest,
	CancelPluginOperationResponse,
	PluginMutationOperationRequest,
} from "@ling/contracts/plugin";
import { isBuiltinOperationRef, sameOperationRef } from "@ling/contracts/owner-ref";
import {
	PLUGIN_MUTATION_MAX_DEADLINE_MS,
	PLUGIN_MUTATION_OWNER_ID,
	type PluginMutationAction,
	pluginMutationRevision,
} from "@ling/contracts/plugin-operation";
import type { OperationExecutionHandle, OperationExecutionRecord } from "../../operations/operation-execution";

import { createOperationRegistry, ownerMismatchError } from "../../operations/operation-registry";
// ── Plugin mutations (same-kind mutations are mutually exclusive; bound to a revision derived from action + source + scope) ──

interface PluginOperationRecord {
	operation: PluginMutationOperationRequest["operation"];
	execution: OperationExecutionRecord;
}

export interface PluginOperationRegistry {
	dispose(): void;
	start(
		action: PluginMutationAction,
		request: PluginMutationOperationRequest & { source: string | null; scope: "global" | "project" | "all" },
	): OperationExecutionHandle;
	cancel(request: CancelPluginOperationRequest): CancelPluginOperationResponse;
}

export function createPluginOperationRegistry(): PluginOperationRegistry {
	const core = createOperationRegistry<PluginOperationRecord>({
		maxDeadlineMs: PLUGIN_MUTATION_MAX_DEADLINE_MS,
		deadlineSubject: "plugin operation",
		cancelledMessage: "The plugin operation was cancelled.",
	});
	let stopping = false;
	return {
		dispose() {
			stopping = true;
			core.cancelWhere(() => true, "Host shutdown");
		},
		start(action, request) {
			if (stopping) throw requestCancelled("Plugin mutation admission has stopped.");
			const expected = {
				scope: { kind: "project" as const, ref: { cwd: request.cwd } },
				revision: pluginMutationRevision(action, request.source, request.cwd, request.scope),
				generation: 0,
			};
			if (!isBuiltinOperationRef(request.operation, PLUGIN_MUTATION_OWNER_ID, expected)) {
				throw ownerMismatchError("The plugin operation owner does not match its mutation binding.");
			}
			return core.begin(request.operation.requestId, request.deadlineAt, (execution) => ({
				operation: request.operation,
				execution,
			}));
		},
		cancel(request) {
			return core.cancelByRequest(
				request.operation.requestId,
				(record) => sameOperationRef(record.operation, request.operation),
				{ code: "STALE_STATE_REVISION", message: "The cancellation target does not own this plugin operation." },
			);
		},
	};
}
