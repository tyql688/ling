import type { PiMethodInput, PiMethodOutput, PiPositionalArgs, RuntimeMethodOptions } from "./method";
import { piRuntimeMethods, type PiRuntimeMethod } from "./runtime-methods";

export interface PiRuntimeCallOptions {
	signal?: AbortSignal;
}
type Methods = typeof piRuntimeMethods;
type Arguments<Method extends PiRuntimeMethod> = PiPositionalArgs<
	PiMethodInput<Methods[Method]>,
	Methods[Method]["parameters"]
>;
export type PiRuntimeClient = {
	[Method in PiRuntimeMethod as Method extends `runtime.${infer Name}` ? Name : never]: (
		...args: Methods[Method]["options"] extends { signal: true }
			? [...Arguments<Method>, signal?: AbortSignal]
			: Arguments<Method>
	) => Promise<PiMethodOutput<Methods[Method]>>;
};
type RuntimeCall = <Method extends PiRuntimeMethod>(
	method: Method,
	args: PiMethodInput<Methods[Method]>,
	options?: PiRuntimeCallOptions,
) => Promise<PiMethodOutput<Methods[Method]>>;

export function createPiRuntimeClient(call: RuntimeCall): PiRuntimeClient {
	return Object.fromEntries(
		Object.entries(piRuntimeMethods).map(([name, method]) => [
			name.slice("runtime.".length),
			(...values: unknown[]) => {
				const args = Object.fromEntries(
					method.parameters.flatMap((field, index) => (values[index] === undefined ? [] : [[field, values[index]]])),
				);
				const behavior: RuntimeMethodOptions = method.options;
				const signal = behavior.signal ? (values[method.parameters.length] as AbortSignal | undefined) : undefined;
				// Iteration erases the correlation between a method and its fields; the table and mapped client retain it for callers.
				return call(name as PiRuntimeMethod, args as PiMethodInput<Methods[PiRuntimeMethod]>, signal ? { signal } : {});
			},
		]),
	) as PiRuntimeClient;
}
