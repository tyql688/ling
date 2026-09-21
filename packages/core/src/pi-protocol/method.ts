import type { PiWorkerRequestPolicy } from "./request-policy";
import { z } from "zod";
interface PiMethod<Input = unknown, Result = unknown> {
	readonly input: z.ZodType<Input>;
	readonly result: (value: unknown) => Result;
}
export function piMethod<Input, Result>(
	input: z.ZodType<Input>,
	result: (value: unknown) => Result,
	policy: PiWorkerRequestPolicy,
): PiMethod<Input, Result> & { readonly policy: PiWorkerRequestPolicy } {
	return { input, result, policy };
}
export type PiMethodInput<P> = P extends PiMethod<infer Input> ? Input : never;
export type PiMethodOutput<P> = P extends PiMethod<unknown, infer Result> ? Result : never;
/** Void operations retain a null wire acknowledgement while public callers observe void. */
export function piVoidMethod<Input>(input: z.ZodType<Input>, policy: PiWorkerRequestPolicy) {
	return piMethod(
		input,
		(value) => {
			z.null().parse(value);
		},
		policy,
	);
}
type PiWireResult<P> = PiMethodOutput<P> extends void ? null : PiMethodOutput<P>;
export type PiMethodHandlers<Table extends Record<string, PiMethod>, Context> = {
	[Method in keyof Table]: (
		input: PiMethodInput<Table[Method]>,
		context: Context,
	) => Promise<PiWireResult<Table[Method]>>;
};
export function dispatchPiMethod<Table extends Record<string, PiMethod>, Context, Method extends keyof Table>(
	table: Table,
	handlers: PiMethodHandlers<Pick<Table, Method>, Context>,
	method: Method,
	input: unknown,
	context: Context,
): Promise<unknown> {
	const procedure = table[method];
	if (!Object.hasOwn(table, method) || !procedure || !Object.hasOwn(handlers, method))
		throw new Error(`Unknown Pi method ${String(method)}`);
	const parsed = procedure.input.parse(input);
	return (handlers[method] as (input: unknown, context: Context) => Promise<unknown>)(parsed, context);
}

export interface RuntimeMethodOptions {
	busy?: boolean;
	acceptReplacement?: boolean;
	timeoutMs?: number;
	signal?: boolean;
}
/** Positional SDK calls use an explicit field order; object property order never defines the API. */
export function runtimeMethod<
	Input,
	Result,
	const Fields extends readonly (keyof Input & string)[],
	const Options extends RuntimeMethodOptions,
>(method: PiMethod<Input, Result> & { readonly policy: PiWorkerRequestPolicy }, parameters: Fields, options: Options) {
	return { ...method, parameters, options };
}
export function domainMethod<
	Input,
	Result,
	const Name extends string,
	const Fields extends readonly (keyof Input & string)[] | null,
	const Options extends Pick<RuntimeMethodOptions, "signal">,
>(
	method: PiMethod<Input, Result> & { readonly policy: PiWorkerRequestPolicy },
	name: Name,
	parameters: Fields,
	options: Options,
) {
	return { ...method, name, parameters, options };
}
export type PiPositionalArgs<Input, Fields extends readonly string[]> = Fields extends readonly [
	infer First extends keyof Input & string,
	...infer Rest extends readonly string[],
]
	? undefined extends Input[First]
		? [value?: Exclude<Input[First], undefined>, ...rest: PiPositionalArgs<Input, Rest>]
		: [value: Input[First], ...rest: PiPositionalArgs<Input, Rest>]
	: [];
