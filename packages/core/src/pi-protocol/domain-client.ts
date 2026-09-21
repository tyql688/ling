import { piDomainMethods } from "./domain-methods";
import type { PiCall } from "./methods";
import type { PiMethodInput, PiMethodOutput, PiPositionalArgs, RuntimeMethodOptions } from "./method";

type Methods = typeof piDomainMethods;
type Arguments<Method extends keyof Methods> = Methods[Method]["parameters"] extends readonly string[]
	? PiPositionalArgs<PiMethodInput<Methods[Method]>, Methods[Method]["parameters"]>
	: [input: PiMethodInput<Methods[Method]>];
export type PiDomainWireClient = {
	[Method in keyof Methods as Methods[Method]["name"]]: (
		...args: Methods[Method]["options"] extends { signal: true }
			? [...Arguments<Method>, signal?: AbortSignal]
			: Arguments<Method>
	) => Promise<PiMethodOutput<Methods[Method]>>;
};

export function createPiDomainWireClient(call: PiCall): PiDomainWireClient {
	return Object.fromEntries(
		Object.entries(piDomainMethods).map(([name, method]) => [
			method.name,
			(...values: unknown[]) => {
				const args =
					method.parameters === null
						? values[0]
						: Object.fromEntries(
								method.parameters.flatMap((field, index) =>
									values[index] === undefined ? [] : [[field, values[index]]],
								),
							);
				const behavior: Pick<RuntimeMethodOptions, "signal"> = method.options;
				const signal = behavior.signal
					? (values[method.parameters?.length ?? 1] as AbortSignal | undefined)
					: undefined;
				// Generic iteration is the only place where method/input correlation needs an assertion.
				return call(name as keyof Methods, args as PiMethodInput<Methods[keyof Methods]>, signal ? { signal } : {});
			},
		]),
	) as PiDomainWireClient;
}
