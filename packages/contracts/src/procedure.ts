export interface RequestProcedure<
	Channel extends string = string,
	Args extends unknown[] = unknown[],
	Result = unknown,
> {
	readonly kind: "request";
	readonly channel: Channel;
	readonly parse: (args: readonly unknown[]) => Args;
	readonly result: { readonly type?: Result };
}
interface EventProcedure<Channel extends string = string, Payload = unknown> {
	readonly kind: "event";
	readonly channel: Channel;
	readonly payload: { readonly type?: Payload };
}
type Procedure = RequestProcedure | EventProcedure;
type ProcedureTable = Readonly<Record<string, Procedure>>;
export type ProcedureArgs<P> = P extends RequestProcedure<string, infer Args> ? Args : never;
export type ProcedureResult<P> = P extends RequestProcedure<string, unknown[], infer Result> ? Result : never;
export type ProcedureClient<Table extends ProcedureTable> = {
	[Name in keyof Table]: Table[Name] extends RequestProcedure<string, infer Args, infer Result>
		? (...args: Args) => Promise<Result>
		: Table[Name] extends EventProcedure<string, infer Payload>
			? (callback: (payload: Payload) => void) => () => void
			: never;
};
export interface ProcedureTransport {
	invoke<Result>(channel: string, args: readonly unknown[]): Promise<Result>;
	subscribe<Payload>(channel: string, callback: (payload: Payload) => void): () => void;
}
export function request<const Channel extends string, Args extends unknown[], Result>(
	channel: Channel,
	parse: (args: readonly unknown[]) => Args,
	result: { readonly type?: Result },
): RequestProcedure<Channel, Args, Result> {
	return { kind: "request", channel, parse, result };
}
export function event<const Channel extends string, Payload>(
	channel: Channel,
	payload: { readonly type?: Payload },
): EventProcedure<Channel, Payload> {
	return { kind: "event", channel, payload };
}
export function returns<Result>(): { readonly type?: Result } {
	return {};
}
/** Retains the positional wire format; schemas may normalize individual arguments. */
export function argumentsOf<Args extends unknown[]>(parse: (args: readonly unknown[]) => Args) {
	return parse;
}
/** Older argument-free methods deliberately ignored extra positional arguments. */
export function noArguments(): [] {
	return [];
}
export function createProcedureClient<Table extends ProcedureTable>(
	table: Table,
	transport: ProcedureTransport,
): ProcedureClient<Table> {
	return Object.fromEntries(
		Object.entries(table).map(([name, procedure]) => [
			name,
			procedure.kind === "request"
				? (...args: unknown[]) => transport.invoke(procedure.channel, args)
				: (callback: (payload: unknown) => void) => transport.subscribe(procedure.channel, callback),
		]),
	) as ProcedureClient<Table>;
}
