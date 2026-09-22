# Process model and diagnostics

This document owns the background process topology, worker supervision, failure semantics and the diagnostics store. [Architecture](architecture.md) maps code owners; [Design](design.md) owns interface behavior; [Development](development.md) owns local runs.

## Topology

| Process | Count | Owner | Lifetime |
| --- | --- | --- | --- |
| Desktop shell (Electron main) | 1 | `apps/desktop` | Application lifetime. Absent in browser mode. |
| Host | 1 | `packages/host` | Application lifetime. Standalone Node under Desktop; the same executable in browser mode. |
| Pi control worker | 1 | `packages/host/src/workers/pi/` | Host lifetime, restarted within a budget. |
| Pi session worker | 1 per live session runtime | `packages/host/src/workers/pi/` | From runtime creation to runtime disposal. Never restarted in place. |
| Plugin package host | 0–1 | `packages/host/src/workers/plugin/` | Lazy; released when idle. |
| Terminal and usage workers | 0–n | `packages/host/src/workers/` | Bounded by their owners. |
| Background task processes | 0–16 | `packages/host/src/domains/background-tasks/processes.ts` | Until exit, stop or a one-hour default timeout; at most 4 per session. |

Electron is a shell only. Every business process runs under the Host, and the Host is identical in browser mode. No contract exposes Electron.

## Pi workers

Every Pi worker runs the same entry (`pi-worker-entry.js`) and the same server (`packages/core/src/pi-sdk/entrypoints/pi-worker.ts`). The Host assigns its control/session role during the versioned startup handshake and decides which methods it routes to each worker.

**Control worker.** Receives every domain method: project open/inspect/close, project settings, session catalog listing and discovery, model catalog, credentials and login flows, Pi settings and skills. It never runs a model turn, so its event loop stays responsive. It opens every open project so catalog and credential operations see project resources.

**Session workers.** Receive every runtime method for exactly one runtime: create/resume/fork and the whole turn, queue, extension UI and companion tool calls of that session. A session worker opens a lightweight project context containing its canonical cwd, trusted settings and lifecycle owner; the complete extensions, skills, prompts and context files load only in its runtime, avoiding a second project-catalog graph in every session worker. The control worker owns the complete project catalogs. Project trust is answered from the Host's trust decisions without a second prompt. Forks start a new worker from the source session file, not from the source worker. A session worker exits when its runtime is disposed, including idle suspension.

**Why per session.** A wedged event loop, a leaking extension or a fatal V8 abort affects one session, and the affected session is resumable from its session file. Sessions of the same project do not share fate. The cost is memory: SDK and extension loading give each worker a substantial fixed footprint. The session retention owner keeps up to two warm idle sessions, including selected sessions. A thirty-second sweep also releases unselected idle sessions last accessed at least two minutes ago. Every connected client's viewed session and the latest user selection intent remain protected; starting an automatic task does not replace that intent. The disposal boundary rechecks viewed sessions after asynchronous preparation. Pending interactions and lifecycle operations also prevent eviction; protected sessions consume warm slots and may exceed the idle budget, while running sessions remain live. Unsaved sessions remain live until Pi creates their durable session file. Reopening a retired session restores it from its durable history.

**Usage worker.** Starts on demand and exits after two minutes without requests. Sidebar date-label updates do not trigger scans. Session changes refresh the visible usage summary; otherwise it checks external Pi activity every five minutes while visible, allowing the worker and its parse cache to leave memory between checks.

Streaming token updates are coalesced before message normalization and extension display projection in the SDK adapter. Generation timing still observes every token, and lifecycle/tool boundaries flush pending text before their own events. Subscription disposal cancels pending projections; deferred delivery failures reach the runtime's lifecycle failure owner. The worker transport separately owns ordered delivery and message deltas.

**Generation identity.** Each worker spawn receives a unique generation across all workers for the Host lifetime. Replacement reservations and control frames are keyed by generation, so a late frame from an exited worker cannot reach a newer one.

## Supervision

`workers/host-worker-process.ts` is the one spawn path for every Host worker: piped stdio into the diagnostics store, exit tracking and process-tree termination. `pi-worker-process.ts` supervises one Pi worker generation on top of it: ready handshake, heartbeat, heap observation, graceful shutdown and forced termination. `pi-worker-pool.ts` owns the control worker's restart budget, the session worker set, the shared generation sequence and the live process table.

- Ready handshake within 30 s, or the generation fails.
- Ping every 10 s; the worker answers with heap usage, heap limit and its maximum event-loop delay since the previous pong. No pong for 30 s means the event loop is blocked and the generation fails. Requests whose policy defers the heartbeat (lifecycle loads that run synchronous SDK work) suspend the timeout until they settle.
- System resume reopens the heartbeat window so a sleeping machine does not read as a dead worker.
- Heap above 75 % of the limit logs a warning once; above 90 % an idle worker is recycled gracefully before V8 aborts it.
- Failure diagnostics: the failure log line carries the last heap sample, the last event-loop delay, and every pending request with its method and age. The diagnostics store keeps the worker's own recent lines beside it.

The control worker restarts automatically, at most twice within 30 s. A session worker never restarts in place: its runtime publishes a lifecycle failure, the managed session is released, and the session is resumable.

Graceful shutdown sends a shutdown frame, waits up to 5 s for `shutdownComplete` and process exit, then terminates the process tree. The worker keeps its reverse channel to the Host open until it posts `shutdownComplete`, so runtime callbacks can settle during cleanup; the Host then releases creation bindings and aborts replacement reservations the generation left behind. Host shutdown drains admission first, then session workers, then the control worker.

## Failure semantics for the shell

- A session runtime loss reaches the renderer as a failed `runFinished` with run id `session-lifecycle` and the error code `PI_HOST_LOST`, followed by `session:runtime-suspended` with reason `failed`. The session stays in the sidebar and its transcript remains readable from the projection cache. If it is the visible session, the renderer resumes it once automatically in a fresh worker; a second loss of the same session returns to the home screen until the user selects it again. Any later selection or message resumes it.
- Other sessions keep running. Their UI shows nothing about the failure.
- Losing the control worker fails in-flight catalog, credential and project operations with the same error code; the next operation waits for the replacement worker.
- Losing the Host is a Desktop concern: `host-supervisor.ts` shows the native recovery notice and reconnects a replacement Host. Browser mode reloads against the new origin.

Window creation rechecks shutdown after asynchronous state reads. Fatal errors distinguish startup and runtime, attempt every acquired cleanup, show a native notice and exit with code 1 under a twenty-second deadline. A native sheet parent exists even before the main window so macOS continues processing cleanup. Fatal shutdown cannot install an update, relaunch or mark graphics fallback as a clean run. Update handoff rechecks fatal state after draining Host.

Update checks and downloads stop before Host drains, while updater error listeners remain owned by Electron until its final quit event. Installation errors after handoff reach the native failure notice even after shell IPC has closed. Explicit restart-and-install reopens Ling; installing a downloaded update during ordinary quit uses silent installation without relaunching.

## Diagnostics store

The Host owns `logs/ling-diagnostics.sqlite` under Ling data. It is separate from `ling.sqlite`: diagnostics use `synchronous=NORMAL`, are pruned aggressively and must never block business writes.

```text
logs(id INTEGER PRIMARY KEY, at INTEGER, level TEXT, process TEXT, component TEXT, message TEXT,
     session_id TEXT, request_id TEXT, runtime_id TEXT, code TEXT, generation INTEGER)
```

Sources:

- Host logger lines, including component and correlation fields.
- Worker lines. Workers print structured JSON lines on stderr; the Host parses them into rows with the worker's process label. Unstructured lines from extensions or npm are stored as-is under that process label.
- Desktop shell lines, forwarded to the Host over the existing control stdin as JSON lines. Desktop keeps its own bounded launch log for failures that happen before a Host exists.

Writes are batched and flushed every 250 ms, on fatal exit synchronously. Retention keeps 14 days and at most 200 000 rows; pruning runs at startup and hourly.

The `diagnostics` procedures expose the store and the live process table to any client: `diagnostics:logs` queries by cursor, level, process, component, session and text; `diagnostics:processes` lists live workers with role, pid, session, generation, heap and event-loop delay. The Diagnostics settings page renders both in the Web client, so browser and Desktop read the same data.
