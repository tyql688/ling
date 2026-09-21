import type { HostDomain } from "../transport/host-domain";
import type { HostHandle, HostRequestHandler } from "../transport/request-router";
import { createRuntimeLifetime } from "@ling/node-runtime/runtime-lifetime";

export function createHostDomainRuntime(handle: HostHandle) {
	const lifetime = createRuntimeLifetime(["handlers", "workers"] as const);
	return {
		add<Domain extends HostDomain>(label: string, phase: "handlers" | "workers", create: () => Domain): Domain {
			lifetime.assertOpen();
			const domain = create();
			const { prepareShutdown, dispose } = domain;
			if (prepareShutdown) lifetime.onStop(label, prepareShutdown);
			if (dispose) lifetime.defer(phase, label, dispose);
			// Registration can reject a duplicate method. Acquire cleanup first so startup
			// rollback still releases this domain along with all previously added owners.
			for (const [method, handler] of Object.entries(domain.handlers)) {
				handle(method, handler as HostRequestHandler);
			}
			return domain;
		},
		prepareShutdown: lifetime.stop,
		dispose: lifetime.dispose,
		fail: lifetime.fail,
	};
}
