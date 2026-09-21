import type { DiagnosticCorrelation } from "@ling/contracts/diagnostics";
import { forwardChildProcessOutput } from "@ling/host/runtime/child-process-output";
import { getHostRuntimePaths } from "@ling/host/runtime/runtime-paths";
import { createLogger } from "@ling/core/logger";
import { terminateProcessTree } from "@ling/node-runtime/process-tree-terminator";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const log = createLogger("host-workers");

export interface HostWorkerProcess {
	readonly child: ChildProcess;
	exited(): boolean;
	/** Terminates the process with its descendants; repeated calls share one outcome. */
	terminate(): Promise<void>;
}

interface SpawnHostWorkerOptions {
	/** Bundled entry file name under the Host entries directory. */
	entry: string;
	/** Process label for diagnostics records produced from this worker's stdio. */
	label: string;
	env?: Record<string, string>;
	serialization?: "advanced" | "json";
	execArgv?: string[];
	correlation?: () => DiagnosticCorrelation | undefined;
}

/** One spawn path for every Host worker: piped stdio into diagnostics, exit tracking and tree termination. */
export function spawnHostWorkerProcess(options: SpawnHostWorkerOptions): HostWorkerProcess {
	const child = fork(join(getHostRuntimePaths().hostEntriesDir, options.entry), [], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		serialization: options.serialization ?? "advanced",
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
	});
	forwardChildProcessOutput(child, options.label, options.correlation);
	// A spawn or IPC failure without a listener would throw in the Host; owners react to it through their own listeners.
	child.on("error", (error) => log.error(`${options.label} worker process failed:`, error));
	let exited = false;
	child.once("exit", () => {
		exited = true;
	});
	let termination: Promise<void> | null = null;
	return {
		child,
		exited: () => exited,
		terminate() {
			termination ??= (async () => {
				if (exited) return;
				const pid = child.pid;
				if (pid === undefined) {
					child.kill();
					return;
				}
				await terminateProcessTree({ pid, terminateRoot: () => child.kill(), rootExited: () => exited });
			})();
			return termination;
		},
	};
}
