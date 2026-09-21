import { toCommandError } from "@ling/core/command-resolver";
import type { UsageHostErrorDto, UsageHostRequest, UsageHostResponse } from "@ling/core/usage/usage-host-protocol";
import { parseUsageHostResponse, USAGE_HOST_PROTOCOL_VERSION } from "@ling/core/usage/usage-host-protocol";
import { createUsageScanner } from "./usage-scan";
import { getUsageStats } from "./usage-stats";

function errorResponse(
	request: UsageHostRequest,
	code: UsageHostErrorDto["code"],
	message: string,
	retryable: boolean,
): UsageHostResponse {
	return {
		kind: "error",
		protocolVersion: USAGE_HOST_PROTOCOL_VERSION,
		method: request.method,
		error: {
			code,
			message: message.slice(0, 2_000) || "Usage statistics scan failed.",
			retryable,
		},
	};
}

export function createUsageHostService() {
	const scanner = createUsageScanner();

	async function handleRequest(request: UsageHostRequest): Promise<UsageHostResponse> {
		if (Date.now() >= request.deadlineAt) {
			return errorResponse(
				request,
				"REQUEST_DEADLINE_EXCEEDED",
				"The usage statistics request expired before scanning started.",
				true,
			);
		}
		try {
			const result = await getUsageStats(request.rangeDays, request.agentDir, scanner);
			if (Date.now() >= request.deadlineAt) {
				return errorResponse(
					request,
					"REQUEST_DEADLINE_EXCEEDED",
					"The usage statistics request expired while scanning session history.",
					true,
				);
			}
			return parseUsageHostResponse({
				kind: "result",
				protocolVersion: USAGE_HOST_PROTOCOL_VERSION,
				method: request.method,
				result,
			});
		} catch (error) {
			return parseUsageHostResponse(errorResponse(request, "USAGE_SCAN_FAILED", toCommandError(error).message, true));
		}
	}

	return { handleRequest, dispose: scanner.dispose };
}
