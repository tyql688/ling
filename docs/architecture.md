# Architecture

This is a map of current code owners. [AGENTS.md](../AGENTS.md) defines product boundaries, development rules and verification scope. [Design](design.md) defines the interface contract; [Development](development.md) describes local commands and isolation. Keep implementation budgets and specialized maintenance procedures with their source or owning skill.

## Runtime boundaries

| Package | Owns | May depend on |
| --- | --- | --- |
| `packages/contracts` | Browser-safe domain DTOs, validation, procedure declarations, client APIs and transport envelopes | Browser-safe dependencies |
| `packages/core` | Pi adaptation and protocol, pure review/transcript/usage interpretation, shared Node primitives | Contracts, built-in extensions and Node runtime primitives |
| `packages/host` | Business state, persistence, managed sessions, Git/files, application composition, authenticated transport and workers | Core, Contracts and Node runtime primitives |
| `packages/builtin-extensions` | Actual Pi extension implementations | Contracts and public Pi SDK APIs |
| `apps/web` | Feature state, controllers, views and browser transport/shell adapters | Contracts |
| `packages/node-runtime` | Bounded atomic publication, launch log files and process cleanup shared by native and business owners | Node libraries only |
| `apps/desktop` | Native windows, OS integration, updates and Host supervision | Contracts and Node runtime primitives |

Electron and browsers use the same Web client and authenticated Host protocol. Desktop launches an independent Host with a staged Node runtime. Host supervises one Pi control worker, one Pi session worker per live runtime, and the plugin, usage and terminal workers; [Processes](processes.md) owns that topology, supervision and the diagnostics store. Every Pi worker embeds the SDK; a separate Pi CLI or server does not implement conversation runtime. Host enters the adapter through `packages/core/src/pi-sdk/entrypoints/`.

## Contracts and transport

Paths below are relative to `packages/contracts/src/`:

- Domain DTOs, portable validation, identity helpers and procedure tables live directly in `src/`.
- `procedure.ts` defines transport-neutral request/event declarations. Domain `*-procedures.ts` files specify channel names, argument schemas and result types once. Host and clients derive their registration and binding from those declarations.
- `api/host-procedures.ts` composes the business capability tree; `api/ling-api.ts` describes its native adaptation; `api/ling-api-client.ts` adapts transport and native capabilities into the application client. `api/shell-api.ts` and `api/shell-procedures.ts` own native capabilities, with validation repeated in Electron main.
- `protocol/channels.ts` derives the channel registry. `protocol/host-protocol.ts` owns authentication, request, error and replay envelopes. `window.d.ts` describes preload/bootstrap globals only.
- `ling-error.ts`, `session-ref.ts`, `owner-ref.ts`, `records.ts`, `text-validation.ts` and domain validation modules own shared failure, identity and normalization semantics. Domain-specific resource budgets remain distinct even when their numbers match.

Host Web protocol version 5 uses one rejected `LingError` path for failed requests. Domain partial results remain explicit values; errors cannot become authoritative empty success. Error codes are localized in Web, and unexpected failures retain an associated Host log identifier. The protocol test protects established channel identities and explicit additions; the procedure tables are the current capability inventory, including data, session, Pi package and editor-language operations.

Pi worker protocol version 5 assigns control/session roles in the startup handshake and is separate from Web transport. `packages/core/src/pi-protocol/` owns method tables, framing, generation checks, result validation, deadlines and replacement reservations. Domain/runtime/lifecycle/callback tables derive typed clients and worker dispatch. Method arguments admitted by Host are not parsed field by field again in worker dispatch. Disk, extension, callback and worker-result data retain their own boundary validation. Stable `PI_HOST_*` error codes remain wire identities despite the process being named Pi worker.

Pi settings updates use one owning schema, including field-specific retry ranges, unique default tools and native shell-path validation. Host validates input; the SDK owner applies the typed update. SDK persisted settings still have separate read and normalization semantics. Model compaction overrides preserve exact provider/model keys and unknown sibling settings. Cache warming is global, uses Pi’s canonical mode and reconciles live timers through the SDK setter when settings change. Its separate usage entries contribute to token/cost totals without adding assistant messages. Transcript-backed system instructions and tool changes remain in Pi history and model replay, outside the conversation row projection.

## Host owners

```text
packages/host/src/
  index.ts                 executable startup and shutdown
  app/                     business composition and domain registration
  runtime/                 deployment paths, environment, logs and project access ports
  transport/               authenticated HTTP/WebSocket, events and dialogs
  operations/              cancellation, admission and deadline execution
  storage/                 SQLite connection, transactions, schema and import health
  workers/                 shared worker spawn and RPC primitives
    pi/                    worker pool, per-process supervision, transport and runtime mirrors
    plugin/                package process supervision
    terminal/              terminal worker entry and protocol
    usage/                 scan, aggregation and usage worker lifecycle
  domains/
    data/                  shared drafts, user state and recovery requests
    diagnostics/           log store queries and live worker listing
    projects/              project lifetime, trust, catalogs and metadata cleanup
    sessions/              managed registry, runtime commands, dialogs and transcript paging
    files/                 project files and filesystem watchers
    editor/                project language processes, formatting and validated LSP operations
    git/                   Git operations, request adaptation and write serialization
    review/                checkpoints, lineage capture, queries, mutations and persistence
    models/                model configuration and authentication requests
    plugins/               package mutation operations and policy
    companions/            feature store, automatic runs, tool dispatch and Host-side labels
    interactions/          pending questions and approvals for Host features
    questions/             agent questions with retained answers and delivery
    background-tasks/      shell processes beside a session with bounded retained output
    schedules/             recurring agent runs, tick loop and run history
    pi-adapters/           bundled Pi packages: todo projection and permission system activation
    skills/                skill management and CLI update workflow
    resources/             project/session resource reload coordination
    settings/              application settings, composer history and Pi settings
    skins/                 declarative skin package storage and discovery
    terminal/              PTY service and handlers
    usage/                 usage requests
```

`app/business-runtime.ts` acquires the database, domain stores, sessions, review, file watchers, workers, resource reload, project lifecycle and trust owners. `app/business-handlers.ts` composes domain factories with named dependencies. Each domain returns handlers and any owned cleanup. `app/domain-runtime.ts` registers cleanup before binding methods, so failed registration also rolls back the newly acquired domain. Common request handling owns validation, failure logging and normalization; domain handlers adapt transport to business owners.

`packages/node-runtime/src/runtime-lifetime.ts` records cleanup on acquisition. Shutdown stops admission before draining dependencies. Admitted package mutations reconcile resources before project teardown; project operations settle before session bridges and Pi are released; maintenance settles before the database closes. Startup rollback follows the same path, attempts every owner and retains all failures. Repeated disposal shares one result.

`domains/sessions/manager/` owns the managed session registry, metadata, lifecycle queue and commands. `domains/sessions/session-host.ts` binds dialogs, runtime events and cancellation. `domains/sessions/transcript-pager.ts` owns bounded cursor views over durable projection identities. `workers/pi/` owns remote runtime mirrors, attach buffers and reservations. Their consumers declare small lifecycle, project-access and projection-cache ports instead of importing application composition or handler modules.

Project/session coordination is supplied by `app/`. Project identity is canonical cwd; an opened project is required before Pi services can be acquired. Session discovery may lag a live runtime. In-memory summaries survive that lag, and an idle empty SDK session is retained until its actual session file exists: Pi does not flush an empty history before its first assistant message.

Catalog mutations publish `session:catalog-changed` after create, fork, metadata changes and deletion. Every connected client refreshes changed summaries or removes deleted references immediately. A stale concurrent catalog scan cannot overwrite that notification. Deletion cascades through runtime subscriptions, dialogs, shared metadata and each client's active workspace bindings.

UI package operations and the conversation plugin tool converge in `domains/plugins/plugin-mutation.ts`. `domains/resources/resource-reload.ts` reconciles project catalogs and live sessions after mutations, including partial writes. Core's `plugin-host/` owns Pi package protocol/source interpretation; Host's plugin worker owns package process supervision. Built-in features are described below; the permission system's activation changes reconcile through the same resource owner.

Pi requests wait for the supervisor's actual ready handshake. Authentication cancellation fences deferred project admission; an already dispatched SDK flow is cancelled while its original result remains observed for credential reconciliation. A failed WebSocket peer closes independently. An uncaught Host failure stops admission, drains owned workers and exits with code 1 under a bounded deadline.

## Persistence and shared user state

`storage/database.ts` owns `ling.sqlite`, schema version 3, WAL with FULL synchronization, bounded lock waits, transactions and disposal. Domain stores own row validation and one-time imports. The database holds projects, session metadata/catalog caches, drafts and recovery versions, shared preferences/tabs, composer history, application settings, review state and cleanup retries. Pi session JSONL, Pi credentials/settings/packages, declarative skin files and Desktop shell state retain their original owners.

Each legacy source is imported with a transaction and an idempotent marker. The original JSON is preserved byte for byte. A failed source remains visible and retryable without erasing unrelated successful imports. Failed reads never trigger empty initialization. The implementation deliberately does not resume writing old JSON after a database failure: two writable authorities would make recovery ambiguous. One Data Health surface composes database, import and domain recovery results, with expandable/copyable detail and explicit retry.

`domains/data/draft-store.ts` serializes revision-based compare-and-write. A stale client preserves its input as a recoverable conflict instead of replacing another client's draft. Explicit clears keep revisions; choosing a recovery copy retains the displaced draft. Budgets reject excess retained data visibly. `domains/data/user-state-store.ts` applies row-level mutations and revisions for preferences, project labels/pins, tabs, seen markers, reviewed progress and skin scenes. Unrelated concurrent changes are preserved. Tab mutations optionally carry an order of existing sessions; older mutations remain valid, and ordering never recreates closed or deleted tabs. Preview tabs and file/review tab positions remain local to their window.

`lib/user-state/persistence.ts` and the session draft persistence owner hydrate Host snapshots, overlay pending local edits, and apply acknowledged revisions. A bounded local recovery journal contains only unacknowledged changes. Legacy localStorage sources are removed only after Host acknowledges the exact bytes being imported; damaged sources and concurrent edits remain recoverable. Moving to another Host origin no longer loses acknowledged user state. An inaccessible old origin still requires the user to reopen that origin before its browser-local legacy data can be imported.

Session deletion removes drafts, tabs, read markers and reviewed state in one database transaction. Deletion tombstones reject late writes that would recreate deleted session data. Client catalog notifications then clear active selection, mounted composer, viewer/dialog targets and shared tab state.

## Core and Pi adapter

Core retains shell-independent interpretation and SDK integration. `change-review/` contains pure review classification; `transcript/` owns durable entry identity; `skills/` owns CLI ledger/provenance interpretation; `store/atomic-file-store.ts` is a bounded primitive used by remaining file owners. Filesystem watchers, Git, durable business stores, managed-session orchestration, transcript paging and usage scans belong to Host.

`paths.ts` owns native path identity and lexical containment; filesystem canonicalization remains with the caller. `listeners.ts` isolates synchronous subscribers. Shared runtime/resource/discovery types and runtime ports live in `pi-protocol/`, without importing the managed-session registry. Record normalization shared with Web comes from Contracts.

| Pi adapter directory | Responsibility                                                                        |
| -------------------- | ------------------------------------------------------------------------------------- |
| `projects/`          | Project admission, trust, generation and coordinated reload                           |
| `models/`            | Catalogs, configuration, credential scopes and model runtime ownership                |
| `session/`           | SDK runtime construction, commands/queries, replacement, queue and message projection |
| `extensions/`        | Extension binding, Pi UI capability, rendering and input adaptation                   |
| `resources/`         | Pi packages, skill discovery and switches                                             |
| `settings/`          | Canonical Pi settings, mutation and network configuration                             |
| `worker/`            | Typed domain dispatch, dialog bridge and runtime registry                             |
| `entrypoints/`       | Executable adapter boundaries and worker composition                                  |

The Pi entrypoint explicitly constructs network/settings lifetime, model/credential scopes, project access, quotas, turn lifecycle, built-in extension dependencies and UI owners. Model consumers, skill catalog access and session construction declare only the capabilities they use. Project services retain leases, reload barriers, generation checks and disposal. Large constructors hold typed mutable state; module-level operations receive that state explicitly. There is no process-global service locator or test-only reset registry.

Session runtime handles retain their public port identity while the underlying SDK session changes. Manual Ling forks create a distinct sidebar session; a Pi command replacement updates managed identity, subscriptions, dialogs and sidebar together. `navigateTree` remains within the same session file. A `ling:manual-fork` custom entry binds provenance to the current session ID and is excluded from model context. Legacy provenance inference remains an adapter compatibility read for Pi-owned session files, not a parallel Ling database format.

Runtime-bound resources track public `agent_start` and `agent_settled`. Extension settled hooks can outlive apparent Pi idleness, so reload and replacement remain fenced until settlement. Deferred reload notification follows restoration of parked input, including images and file-reference positions. Capacity and restoration failures remain visible.

Unsupported Pi TUI/editor capabilities throw typed unsupported errors. Extension prompts notify the shared Host shell-activity owner; native foreground and notification preferences remain with Desktop. Cancelled prompts do not create alerts. Native GUI adaptations use the original session and prompt owners; they do not make unsupported TUI calls appear successful.

## Built-in features and Pi adapters

Five features live beside the conversation. Their durable state sits under the Ling data home (`~/.ling`, `LING_HOME`) in `plugin-data/<feature>/host-state.json`, one revisioned value per feature through `domains/companions/feature-store.ts`. The permission system's activation lives in `plugin-data/ling-permission-system/pi-activation.json`. Nothing under the data home moves existing Ling app data, Pi credentials or declarative skins.

`domains/companions/builtin-features.ts` owns the five global switches in `plugin-state/builtin-features.json`, initially importing disabled built-in IDs from the retired `plugin-state/plugins.json` without rewriting it. Settings exposes them under Plugins. Writes reconcile through the shared resource reload coordinator, publish change events to both Web and Desktop, and defer busy sessions until the current turn ends. Disabled Host features reject new work while history, pending answers and stop controls remain available. Scheduling does not dispatch while disabled and skips occurrences due before its last re-enable timestamp. The permission master switch overrides effective access without rewriting project choices or rule files; turning it on restores those choices. Disabling bundled Todo leaves a separately installed Pi Todo package alone.

`domains/interactions/` retains questions and approvals a feature is waiting on; each pending request keeps its session runtime retained. `domains/companions/companion-runs.ts` starts automatic agent runs through the session host, one per session, and tracks them until they settle. `domains/companions/tool-dispatch.ts` receives every companion tool call from the Pi worker (`companions.invoke`), validates the input against `contracts/companion-tools.ts` and routes it to the owning feature.

`domains/questions/` implements `ask_user`, `ask_user_async` and `question_result`; an answered question is delivered into the conversation as a steer message whose durable custom entry prevents a second delivery. `domains/background-tasks/` implements `background_*` with detached process groups, independent output cursors and a two-mebibyte retained tail mirrored to disk, which serves a task's output once it has settled. `domains/schedules/` implements `schedule_list` and `schedule_create` beside the settings page: a one-second tick, at most two concurrent runs, missed-run policy and bounded history.

`domains/pi-adapters/` adapts two bundled Pi packages and holds no business state. `adapter-plan.ts` resolves their entry files once and answers the worker's `adapters.read` request per project: the feature switches, enabled bundled Todo entry, permission package entry and effective permission activation for that project. `todo/` projects the latest `todo` tool result and can start a reconciliation run; `permission-system/` owns activation writes, the reload they trigger and the rule file entry points.

When Todo is enabled, `core/pi-sdk/extensions/pi-todo-reconciliation.ts` gives a successful request that used verified Todo results one automatic follow-up if tasks remain open. Pi queues it inside the same run; the budget resets only for a new prompt or settled/session lifecycle, not each retry or continuation. Aborted/failed turns, pending user messages, unavailable tools and unverified result origins do not trigger reconciliation. The original Todo tool still owns every status change: completion needs evidence, and blocked or unfinished work stays open. The manual progress check remains available.

In the worker, `core/pi-sdk/extensions/pi-adapters.ts` builds the project's extension list: every enabled user extension, plus a bundled package only when the user has not installed the same package through Pi, minus every copy of the permission system when the project runs with full access. Bundled entries are decorated with `ling:todo` and `ling:permission-system` source identities. `pi-tool-origin.ts` records each tool call's owning extension on the transcript branch before execution; `pi-resource-identity.ts` reads the loaded inventory's identities and versions. Features project only results whose recorded origin they verified and otherwise keep Pi's rendering. `packages/builtin-extensions/src/plugins/companion-tools/` registers only enabled companion tools with Pi and forwards each call to the Host.

## Streaming and Web state

Text and thinking updates use UTF-16 append deltas, coalesced on the existing 16 ms interval. Boundary messages remain complete. Sessions with Markdown transformers keep full-frame projection because a transformer can rewrite earlier output. Worker and Host mirrors apply the same append semantics; generation, sequence and revision fences remain with their respective transport/runtime owners. Snapshots and replay still provide authoritative recovery.

Web has one SessionView record per session, with field selectors for narrow subscriptions. `features/sessions/runtime/session-view.ts` reduces fenced events, batches, snapshots, resync, replacement, hibernation and eviction. Durable-history projection uses a page's branch order and shared message identities to place missing history around live messages; snapshot arrival order and timestamps never determine conversation order. It preserves live row keys and loaded tool bodies when incoming records are deferred, and keeps completed pages if later reads fail. Stream admission, retained history and virtualized geometry retain separate owners.

`main.tsx` creates the session projection runtime before React mounts. Its abort signal releases subscriptions, pending refresh state and companion queues. Bootstrap rollback uses the same cleanup path as page exit. `HostApiContext` injects immutable API slices into features; only bootstrap/platform files read `window.ling`. Non-React terminal owners receive explicit API capabilities.

| Web owner | Responsibility |
| --- | --- |
| `bootstrap.ts`, `main.tsx`, `app/`, `platform/` | Connection, renderer lifetime, providers, product composition and shell adaptation |
| `features/projects/`, `features/sessions/` | Project/session state, lifecycle, drafts, stream projection and retention |
| `features/chat/` | Conversation orchestration, composer, transcript and extension UI subdomains |
| `features/workspace/` | Navigation, layout, dialogs, viewers and cross-feature deletion composition |
| `features/files/`, `features/review/` | File buffers, Monaco/LSP bridge, explorer/preview and review snapshots, diff annotations and navigation |
| `features/terminal/` | PTY/emulator lifecycle and project terminal panels |
| `features/models/`, `features/plugins/`, `features/skills/` | Models/authentication and Pi resource management |
| `features/interactions/`, `features/questions/`, `features/background-tasks/`, `features/schedules/` | Pending request cards and the question, background task and schedule pages |
| `features/pi-adapters/`, `features/companions/` | Todo projection, access mode control and settings, and the shared feature snapshot hook |
| `features/settings/`, `features/usage/` | Preferences, appearance and usage presentation |
| `lib/user-state/`, `lib/preferences/`, `lib/appearance/` | Shared acknowledged state, local view preferences and appearance |

Shared view/controller primitives belong in `components/workbench/`; cross-screen navigation state belongs in `lib/navigation-state.ts` and its action port in `lib/app-navigation.ts`. Session feature navigation uses `components/workbench/feature-navigation.ts`. Features do not import the app or workspace composition roots. Workspace exposes independently selected state for selection, sidebar, model feedback, tabs, panels, session actions and navigation history. Dialogs are a discriminated union capturing their original target. Controllers expose stable actions; title/sidebar subscriptions avoid ordinary streaming message updates; current-provider feedback reaches only the sidebar usage footer.

Settings can cover a retained workspace without changing transcript geometry. Hidden surfaces are inert and release global input listeners. Transcript reading position remains owned by its virtualizer. File reads, preview failures, model settings/login flows and quick-start preparation remain in their owning hooks; components render those states. A file refresh keeps the mounted editor and last complete preview, with refresh errors visible beside retained content. Dirty file documents remain retained across navigation and explicit save failures. The Host file domain serializes saves by canonical target, including symlink aliases, and verifies the expected disk revision inside that queue; admitted saves retain their project lifecycle lease through settlement.

The workspace composes four independent regions. `tab-state.ts` owns conversation membership/preview and focused group; `reading-state.ts` owns window-local reading worksets keyed by session ref, including same-cwd sessions. Worksets retain files/diffs, view positions, rightbar navigation, terminal visibility and reading expansion, with cleanup on session/project removal and stale view callbacks fenced to existing owners. Geometry belongs to a versioned renderer preference; responsive constraints remain transient. Closing a reading tab cannot mutate conversation membership.

`WorkbenchSlotHost` lays out conversation, reading and contextual sidebar independently. `TranscriptTimeline` presents the original Composer and transcript in either a column or a bottom-anchored floating surface, retaining identity, nonzero measurement geometry and prompt visibility. `file-document-state.ts` retains dirty shared buffers keyed by cwd + path; Monaco owns model lifetime and per-session view state. A close request captures its original workset and files before saving. Pierre owns diff geometry while the reading tab retains the last scroll offset. Terminal rendering lives below the conversation; project PTY ownership remains unchanged. One explicit right-panel visibility state collapses reading and its contextual sidebar without clearing reading tabs, file buffers or view state. Conversation artwork remains owned by that conversation column. Monaco keeps document/undo ownership while the Host editor domain owns project language processes, trusted project formatting and LSP validation. TS/JS uses TypeScript 7 with the project configuration and dependencies; unsupported languages retain plain editing without claiming language-server support. The Web bridge mirrors versioned buffers, previews cross-file edits before applying them, retains bounded reference models and opens navigation targets in the session’s existing reading tabs. Language processes are scoped to client/project/server revision and drain with those owners. Pi selection actions append current text and diagnostics to the original Composer draft.

The shared Tiptap editor is lazy-loaded for home/session composers and message/queue edits. It owns document, selection and bounded undo history. Markdown mode is **off by default**; changing mode rebuilds the editor schema while retaining draft and inline context. Plain mode preserves literal whitespace and Markdown source. Drafts persist text and bounded context positions, not editor JSON; image attachments retain their transient lifetime. Submission expands context through session-owned projection. Failed send and cancelled queue editing preserve the complete local draft.

Pi completion and editor synchronization carry the original session/runtime/generation and cursor mapping. A replaced, hidden or deleted editor cannot accept a late result or steal focus. Authenticated project images continue through `MarkdownImage`, including editor and Markstream nodes. Error formatting, locale keys, status vocabulary and empty states have shared owners; failed reads never masquerade as empty success.

## Appearance and Desktop

Contracts owns declarative skin schemas; Host owns packages, watchers and authenticated asset routes. Web appearance owners resolve root material/palette tokens, selection and scene placement. `skins/apply-skin.ts` writes the boot cache consumed by `public/theme-init.js`. Desktop supplies native material capability rather than another palette resolver. A skin can change effective appearance without rewriting the saved theme or remounting transcripts. Authoring details belong in the [skin manifest reference](../builtin-skills/skin-studio/references/skin-manifest.md).

Desktop `main.ts` composes native owners. `shell/window.ts` owns window creation, exact-origin navigation, theme/zoom and persisted geometry. `host/host-supervisor.ts` makes unexpected exits visible and reconnects a replacement Host. `shell/shutdown.ts` stops admission, drains owned cleanup and coordinates normal exit, fatal exit and update handoff. `shell/updater.ts` owns update state. Shell procedure registration derives from Contracts and revalidates native inputs.

Desktop keeps a bounded launch log under `logs/desktop/` for failures before a Host exists and forwards later lines to the Host. The Host owns the diagnostics store described in [Processes](processes.md); `packages/node-runtime/src/launch-log.ts` owns the Desktop file limits and process-exit closure. Console logging remains available if either sink fails.

## Shared interface implementation

[Design](design.md) owns the current component map, customization boundaries and UI acceptance workflow. `apps/web/src/components/ui` owns shared controls and surfaces. Host feature pages compose those controls directly. `features/chat/extension-ui/` adapts Pi prompts, panels, widgets and status, while the Core Pi adapter retains their capability and lifetime boundaries. Browser folder selection uses the same Dialog and form controls as the application; Desktop retains the native folder picker. The authenticated `project:browseDirectories` request lists bounded folder choices before project admission, using Host-native absolute paths without exposing file contents. Existing project file requests still require an open project. Code and diff views acquire the shared highlighting worker only while mounted.
