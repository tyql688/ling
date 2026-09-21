import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** stdout cap when enumerating the process table. 4MiB covers thousands of ps/wmic lines; guards against an abnormal flood. */
const PROCESS_TABLE_MAX_BYTES = 4 * 1024 * 1024;
/** Timeout for pulling the process table. 2s is ample for local enumeration; longer only slows the plugin/terminal cleanup path. */
const PROCESS_TABLE_TIMEOUT_MS = 2_000;
/** Grace for children to exit on their own after a gentle terminate; 500ms covers most cooperative exits. */
const TERMINATION_GRACE_MS = 500;
/** Short grace after a forced kill; 250ms confirms zombies/handles are released, avoiding instant pid-reuse misjudgment. */
const FORCED_EXIT_GRACE_MS = 250;
/** Interval for polling "has the root/child exited"; 25ms balances responsiveness against idle CPU. */
const EXIT_POLL_INTERVAL_MS = 25;
/** Max descendants handled in one termination. 8k far exceeds a normal tool tree; more implies a cycle/enumeration bug — truncate to prevent OOM. */
const MAX_DESCENDANTS = 8_192;

interface ProcessIdentity {
	pid: number;
	parentPid: number;
	startedAt: string;
}

interface ProcessTreeTarget {
	pid: number;
	terminateRoot(): void;
	rootExited(): boolean;
}

function assertTarget(target: ProcessTreeTarget): void {
	if (!Number.isSafeInteger(target.pid) || target.pid <= 1)
		throw new Error("Process tree root PID must be greater than 1");
	if (target.pid === process.pid) throw new Error("Process tree terminator cannot target the current process");
}

function parsePosixProcessTable(output: string): ProcessIdentity[] {
	if (Buffer.byteLength(output, "utf8") > PROCESS_TABLE_MAX_BYTES) {
		throw new Error("Process table exceeds its bounded output limit");
	}
	const processes: ProcessIdentity[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match) throw new Error("Process table contains an invalid row");
		const pid = Number(match[1]);
		const parentPid = Number(match[2]);
		const startedAt = match[3];
		if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0 || !startedAt) {
			throw new Error("Process table contains an invalid identity");
		}
		processes.push({ pid, parentPid, startedAt });
	}
	return processes;
}

async function listPosixProcesses(): Promise<ProcessIdentity[]> {
	const result = await execFileAsync("ps", ["-axo", "pid=,ppid=,lstart="], {
		encoding: "utf8",
		maxBuffer: PROCESS_TABLE_MAX_BYTES,
		timeout: PROCESS_TABLE_TIMEOUT_MS,
	});
	return parsePosixProcessTable(String(result.stdout));
}

async function runWindowsTaskkill(pid: number): Promise<void> {
	await execFileAsync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
		encoding: "utf8",
		// Process-table output cap 256KiB, 5s timeout: the termination fallback path must fail fast
		maxBuffer: 256 * 1024,
		timeout: 5_000,
		windowsHide: true,
	});
}

async function waitForRootExit(target: ProcessTreeTarget, graceMs: number): Promise<boolean> {
	const deadline = Date.now() + graceMs;
	while (!target.rootExited()) {
		const remainingWait = deadline - Date.now();
		if (remainingWait <= 0) return false;
		await delay(Math.min(EXIT_POLL_INTERVAL_MS, remainingWait));
	}
	return true;
}

function collectDescendants(processes: ProcessIdentity[], rootPid: number): ProcessIdentity[] {
	const byParent = Map.groupBy(processes, (identity) => identity.parentPid);
	const descendants: Array<ProcessIdentity & { depth: number }> = [];
	const queue = (byParent.get(rootPid) ?? []).map((identity) => ({ ...identity, depth: 1 }));
	const seen = new Set<number>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || seen.has(current.pid)) continue;
		seen.add(current.pid);
		descendants.push(current);
		if (descendants.length > MAX_DESCENDANTS) throw new Error("Process tree exceeds its descendant limit");
		for (const child of byParent.get(current.pid) ?? []) queue.push({ ...child, depth: current.depth + 1 });
	}
	descendants.sort((left, right) => right.depth - left.depth || right.pid - left.pid);
	return descendants;
}

function signalIgnoringMissing(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function sameIdentity(current: ProcessIdentity[], expected: ProcessIdentity): boolean {
	return current.some((identity) => identity.pid === expected.pid && identity.startedAt === expected.startedAt);
}

interface ProcessTreeState {
	remainingDescendants: ProcessIdentity[];
	rootAlive: boolean;
}

async function waitForProcessTreeExit(
	target: ProcessTreeTarget,
	rootIdentity: ProcessIdentity,
	descendants: ProcessIdentity[],
	graceMs: number,
): Promise<ProcessTreeState> {
	const deadline = Date.now() + graceMs;
	let remainingDescendants = descendants;
	let rootAlive = true;

	while (rootAlive || remainingDescendants.length > 0) {
		const remainingWait = deadline - Date.now();
		if (remainingWait <= 0) break;
		await delay(Math.min(EXIT_POLL_INTERVAL_MS, remainingWait));

		// PTY and worker exit events usually arrive within one event-loop
		// turn. Avoid spawning `ps` for the common leaf-process close path.
		if (remainingDescendants.length === 0 && target.rootExited()) {
			return { remainingDescendants, rootAlive: false };
		}

		const current = await listPosixProcesses();
		remainingDescendants = descendants.filter((identity) => sameIdentity(current, identity));
		rootAlive = sameIdentity(current, rootIdentity);
	}

	return { remainingDescendants, rootAlive };
}

export async function terminateProcessTree(target: ProcessTreeTarget): Promise<void> {
	assertTarget(target);
	if (target.rootExited()) return;
	if (process.platform === "win32") {
		try {
			await runWindowsTaskkill(target.pid);
		} catch (error) {
			// A child-process exit event can arrive just after taskkill reports that the PID is gone.
			if (await waitForRootExit(target, FORCED_EXIT_GRACE_MS)) return;
			throw new Error(`Windows could not terminate process tree ${target.pid}`, { cause: error });
		}
		return;
	}

	const initial = await listPosixProcesses();
	const rootIdentity = initial.find((identity) => identity.pid === target.pid);
	target.terminateRoot();
	if (!rootIdentity) {
		// The process has already disappeared from the observable table and its exit event is lagging.
		// Do not walk this unverified PID: it may already belong to an unrelated process tree.
		if (await waitForRootExit(target, TERMINATION_GRACE_MS + FORCED_EXIT_GRACE_MS)) return;
		throw new Error("Process tree root was not observable and did not report exit");
	}
	const descendants = collectDescendants(initial, target.pid);
	for (const descendant of descendants) signalIgnoringMissing(descendant.pid, "SIGTERM");
	const afterGrace = await waitForProcessTreeExit(target, rootIdentity, descendants, TERMINATION_GRACE_MS);
	if (!afterGrace.rootAlive && afterGrace.remainingDescendants.length === 0) return;

	for (const descendant of afterGrace.remainingDescendants) {
		signalIgnoringMissing(descendant.pid, "SIGKILL");
	}
	if (afterGrace.rootAlive) signalIgnoringMissing(target.pid, "SIGKILL");
	const final = await waitForProcessTreeExit(
		target,
		rootIdentity,
		afterGrace.remainingDescendants,
		FORCED_EXIT_GRACE_MS,
	);
	if (final.remainingDescendants.length > 0 || final.rootAlive) {
		throw new Error("Process tree did not terminate within its bounded grace period");
	}
}

/** Terminate a POSIX process group created with detached:true, including children orphaned by its shell. */
export async function terminateProcessGroup(pid: number): Promise<void> {
	assertTarget({ pid, rootExited: () => false, terminateRoot() {} });
	if (process.platform === "win32") throw new Error("POSIX process groups are unavailable on Windows");
	const alive = async () => {
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
			if ((error as NodeJS.ErrnoException).code === "EPERM") {
				// Darwin can report EPERM as an orphaned group's last member exits. Verify absence;
				// a group that still exists must retain the actual permission failure.
				const { stdout } = await execFileAsync("ps", ["-axo", "pgid="], {
					encoding: "utf8",
					maxBuffer: PROCESS_TABLE_MAX_BYTES,
					timeout: PROCESS_TABLE_TIMEOUT_MS,
				});
				const table = String(stdout).trim();
				const groups = table.split(/\s+/).map(Number);
				if (!table || groups.some((group) => !Number.isSafeInteger(group) || group < 0))
					throw new Error("Process table contains an invalid process group", { cause: error });
				if (!groups.includes(pid)) return false;
			}
			throw error;
		}
	};
	if (!(await alive())) return;
	signalIgnoringMissing(-pid, "SIGTERM");
	const wait = async (duration: number) => {
		const deadline = Date.now() + duration;
		while ((await alive()) && Date.now() < deadline) await delay(EXIT_POLL_INTERVAL_MS);
		return !(await alive());
	};
	if (await wait(TERMINATION_GRACE_MS)) return;
	signalIgnoringMissing(-pid, "SIGKILL");
	if (!(await wait(FORCED_EXIT_GRACE_MS))) throw new Error("Background process group did not terminate");
}
