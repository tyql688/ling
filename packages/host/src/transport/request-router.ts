import { createHostProcedures } from "@ling/contracts/api/host-procedures";
import type { RequestProcedure } from "@ling/contracts/procedure";
import type { HostProductKind } from "@ling/contracts/protocol/host-protocol";
import { toCommandError } from "@ling/core/command-resolver";
import { createLingError, requestCancelled } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { absolutePathSchema, isTildePath } from "@ling/core/paths";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isExpectedRequestControlFlow, normalizeRequestError } from "./request-error";

export interface HostRequestContext {
	clientId: string;
	product: HostProductKind;
	signal: AbortSignal;
}

export type HostRequestHandler = (context: HostRequestContext, ...args: unknown[]) => Promise<unknown>;

export type HostHandle = <Args extends unknown[], Result>(
	method: string,
	handler: (context: HostRequestContext, ...args: Args) => Promise<Result>,
) => void;

export interface HostRequestRouter {
	handle: HostHandle;
	dispatch(method: string, context: HostRequestContext, args: unknown[]): Promise<unknown>;
	has(method: string): boolean;
	assertComplete(): void;
	stop(): void;
}

export function requestFingerprint(method: string, args: readonly unknown[]): string {
	return createHash("sha256")
		.update(JSON.stringify([method, args]))
		.digest("hex");
}

const log = createLogger("host-requests");
export function createHostRequestRouter(): HostRequestRouter {
	const handlers = new Map<string, HostRequestHandler>();
	const procedures = new Map<string, RequestProcedure>();
	for (const domain of Object.values(
		createHostProcedures({
			absolute: absolutePathSchema,
			isAbsolute,
			isTildePath,
			windows: process.platform === "win32",
		}),
	)) {
		for (const procedure of Object.values(domain)) {
			if (procedure.kind !== "request") continue;
			if (procedures.has(procedure.channel)) throw new Error(`Duplicate Host procedure ${procedure.channel}`);
			procedures.set(procedure.channel, procedure);
		}
	}
	let stopped = false;
	return {
		handle: <Args extends unknown[], Result>(
			method: string,
			handler: (context: HostRequestContext, ...args: Args) => Promise<Result>,
		): void => {
			if (stopped) throw new Error("Cannot register a handler after Host shutdown starts");
			if (handlers.has(method)) throw new Error(`Ling host method ${method} is already registered`);
			handlers.set(method, handler as HostRequestHandler);
		},
		dispatch: async (method, context, args) => {
			if (stopped) throw requestCancelled("Ling host is shutting down.");
			const handler = handlers.get(method);
			if (!handler) throw Object.assign(new Error(`Unknown Ling host method ${method}`), { code: "UNKNOWN_METHOD" });
			try {
				const procedure = procedures.get(method);
				// Native shell activity and test-local routers may register their own bounded methods.
				const parsed = procedure ? procedure.parse(args) : args;
				return await handler(context, ...parsed);
			} catch (cause) {
				const error = toCommandError(cause);
				const dto = normalizeRequestError(error, { fallbackMessage: "Ling host request failed" });
				if (!isExpectedRequestControlFlow(dto) && dto.category !== "validation") {
					log.write("error", `${method} failed [${dto.causeId}]`, { code: dto.code }, cause);
				}
				throw createLingError(dto, cause);
			}
		},
		has: (method) => handlers.has(method),
		assertComplete() {
			const missing = [...procedures.keys()].filter((method) => !handlers.has(method));
			if (missing.length > 0) throw new Error(`Missing Host handlers: ${missing.join(", ")}`);
		},
		stop() {
			stopped = true;
			handlers.clear();
		},
	};
}
