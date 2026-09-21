import type { HostRequest } from "@ling/contracts/api/host-procedures";
import type { ProcedureArgs, ProcedureResult } from "@ling/contracts/procedure";
import type { HostRequestContext } from "./request-router";

export type HostHandlers = {
	readonly [P in HostRequest as P["channel"]]?: (
		context: HostRequestContext,
		...args: ProcedureArgs<P>
	) => Promise<ProcedureResult<P>>;
};

/** A domain exposes its requests and owns the subscriptions or workers they acquire.
 * The composition root chooses cleanup phases and registers ownership before routing. */
export interface HostDomain {
	handlers: HostHandlers;
	prepareShutdown?(): void;
	dispose?(): void | Promise<void>;
}
