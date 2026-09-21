import type {
	PiWorkerRuntimeEvent,
	PiWorkerRuntimeState,
	PiWorkerRuntimeStateSnapshotResult,
} from "@ling/core/pi-protocol/protocol";
import { PI_WORKER_PROTOCOL_VERSION } from "@ling/core/pi-protocol/wire-format";
import { describe, expect, it, vi } from "vitest";
import { createPiWorkerRuntimeMirror } from "@ling/host/workers/pi/pi-worker-runtime-mirror";
import { createPiWorkerRemoteRuntime } from "./pi-worker-session-runtime";

const ref = { cwd: "/project", sessionId: "session" };
function state(): PiWorkerRuntimeState {
	return {
		revision: 1,
		ref,
		sessionFile: null,
		sessionName: null,
		snapshot: { busy: false, queue: { revision: 0, steering: [], followUp: [] }, diagnostics: [] },
		commandCatalog: { skills: [], prompts: [], extensions: [] },
		resources: {
			lifecycle: "active",
			replacementListeners: 0,
			snapshotChangedListeners: 0,
			transcriptInvalidatedListeners: 0,
			transcriptProjectionChangedListeners: 0,
			lifecycleFailureListeners: 0,
			replacementCoordinatorOwned: false,
			queueMirrorOwned: true,
			extensionUiOwned: true,
			runtimeServicesOwned: true,
		},
		summary: {
			sessionFilePath: "/session.jsonl",
			storedTitle: "session",
			updatedAt: 1,
			messageCount: 0,
			preview: "",
			transcriptCacheKey: null,
		},
	};
}
const busy = (sequence: number, value: boolean): PiWorkerRuntimeEvent => ({
	kind: "runtimeBusy",
	protocolVersion: PI_WORKER_PROTOCOL_VERSION,
	generation: 1,
	runtimeId: "runtime",
	sequence,
	busy: value,
});

function setup(initial: PiWorkerRuntimeEvent[] = []) {
	const read = Promise.withResolvers<PiWorkerRuntimeStateSnapshotResult>();
	const fail = vi.fn();
	const release = vi.fn();
	const mirror = createPiWorkerRuntimeMirror(
		"runtime",
		state(),
		{ call: <Result>() => read.promise as Promise<Result>, fail, release },
		initial,
	);
	mirror.subscribe(() => undefined);
	return { mirror, read, fail, release };
}

// Snapshot fences are installed by the serialized read tail; let its microtasks settle
// before sending frames that are supposed to race the in-flight snapshot.
const turn = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});

describe("Host runtime mirror", () => {
	it.each(["accepted", "rejected"])("keeps a background admission busy until it is %s", async (outcome) => {
		const admission = Promise.withResolvers<null>();
		const runtime = createPiWorkerRemoteRuntime("runtime", state(), {
			call: <Result>() => admission.promise as Promise<Result>,
			fail: vi.fn(),
			release: vi.fn(),
		});
		const request = runtime.startCompanionRun("run", "test", {});
		const result =
			outcome === "accepted"
				? expect(request).resolves.toBeNull()
				: expect(request).rejects.toThrow("admission failed");
		try {
			expect(runtime.isBusy()).toBe(true);
		} finally {
			if (outcome === "accepted") admission.resolve(null);
			else admission.reject(new Error("admission failed"));
			await result;
		}
		expect(runtime.isBusy()).toBe(false);
	});

	it("delivers attachment events in order and ignores duplicate sequence numbers", async () => {
		const h = setup([busy(1, true)]);
		await turn();
		expect(h.mirror.isHostBusy()).toBe(true);
		h.mirror.handleHostEvent(busy(1, false));
		expect(h.mirror.isHostBusy()).toBe(true);
		h.mirror.handleHostEvent(busy(2, false));
		expect(h.mirror.isHostBusy()).toBe(false);
		h.mirror.markDisposed();
	});

	it("captures exactly the snapshot boundary before applying newer live events", async () => {
		const h = setup();
		await turn();
		const snapshot = h.mirror.getStateSnapshotAtBoundary(() => h.mirror.isHostBusy());
		await turn();
		h.mirror.handleHostEvent(busy(1, true));
		h.mirror.handleHostEvent(busy(2, false));
		expect(h.mirror.isHostBusy()).toBe(false);
		h.read.resolve({ ref, snapshot: { ...state().snapshot, busy: true }, eventSequence: 1 });
		expect((await snapshot).boundary).toBe(true);
		await turn();
		expect(h.mirror.isHostBusy()).toBe(false);
		expect(h.fail).not.toHaveBeenCalled();
		h.mirror.markDisposed();
	});

	it("rejects an unaccounted snapshot sequence instead of discarding live state", async () => {
		const h = setup();
		await turn();
		const result = h.mirror.getStateSnapshotAtBoundary(() => null);
		const rejected = expect(result).rejects.toThrow("boundary mismatch");
		await turn();
		h.read.resolve({ ref, snapshot: state().snapshot, eventSequence: 3 });
		await rejected;
		expect(h.fail).toHaveBeenCalledTimes(1);
		h.mirror.markDisposed();
	});

	it("reports host loss once and rejects a late snapshot after disposal", async () => {
		const h = setup();
		await turn();
		const snapshot = h.mirror.getStateSnapshotAtBoundary(() => null);
		const rejected = expect(snapshot).rejects.toMatchObject({ code: "PI_HOST_RUNTIME_UNAVAILABLE" });
		await turn();
		h.mirror.markDisposed();
		h.read.resolve({ ref, snapshot: state().snapshot, eventSequence: 0 });
		await rejected;
		const other = setup();
		other.mirror.handleHostLost(new Error("gone"));
		other.mirror.handleHostLost(new Error("gone again"));
		expect(other.release).toHaveBeenCalledExactlyOnceWith("runtime");
		expect(() => other.mirror.assertAvailable()).toThrow("gone");
		other.mirror.markDisposed();
	});
});
