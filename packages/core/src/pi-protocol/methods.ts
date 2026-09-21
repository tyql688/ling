import type { SessionRef } from "@ling/contracts/session";
import { piDomainMethods } from "./domain-methods";
import { piRuntimeMethods } from "./runtime-methods";
import { piLifecycleMethods } from "./lifecycle-methods";
import type { PiMethodInput, PiMethodOutput } from "./method";
export const piMethods = { ...piDomainMethods, ...piRuntimeMethods, ...piLifecycleMethods };
export type PiWorkerMethod = keyof typeof piMethods;
export type PiWorkerDomainMethod = keyof typeof piDomainMethods;
export type PiWorkerRuntimeMethod = keyof typeof piRuntimeMethods | keyof typeof piLifecycleMethods;
export const PI_WORKER_METHODS = Object.keys(piMethods) as PiWorkerMethod[];
export const PI_WORKER_DOMAIN_METHODS = Object.keys(piDomainMethods) as PiWorkerDomainMethod[];
export function isPiWorkerRuntimeMethod(method: PiWorkerMethod): method is PiWorkerRuntimeMethod {
	return Object.hasOwn(piRuntimeMethods, method) || Object.hasOwn(piLifecycleMethods, method);
}
export type PiMethodParams<Method extends PiWorkerMethod> = PiMethodInput<(typeof piMethods)[Method]>;
export type PiMethodResult<Method extends PiWorkerMethod> = PiMethodOutput<(typeof piMethods)[Method]>;
export function parsePiWorkerOperationResult(method: PiWorkerMethod, value: unknown): unknown {
	return piMethods[method].result(value);
}

export type PiRequestParams<Method extends PiWorkerMethod> = Method extends keyof typeof piRuntimeMethods
	? { runtimeId: string; ref: SessionRef } & (Record<string, never> extends PiMethodParams<Method>
			? { args?: PiMethodParams<Method> }
			: { args: PiMethodParams<Method> })
	: PiMethodParams<Method>;
interface PiCallOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}
export type PiCall<Options extends PiCallOptions = PiCallOptions> = <Method extends PiWorkerMethod>(
	method: Method,
	params: PiRequestParams<Method>,
	options?: Options,
) => Promise<PiMethodResult<Method>>;
