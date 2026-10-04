# Working on Ling

Use this file for product scope, development constraints and test selection. Use current source and configuration as implementation evidence. [Architecture](docs/architecture.md) maps code owners, [Design](docs/design.md) defines interface behavior, [Processes](docs/processes.md) defines the process model and diagnostics, [Development](docs/development.md) describes local runs, and repository skills own specialized maintenance workflows. Keep each topic in its linked document.

## Product scope

Ling is a GUI/Web host for Pi: projects and Pi sessions, change review/diff, models, Pi package management, usage stats, and settings. Conversations can target a user-selected project or the persistent Ling-managed conversation directory under `LING_HOME/conversations`. Host opens that directory automatically and identifies it with `purpose: "conversation"`; it is independent of saved project membership. The resolved cwd identifies the runtime's working directory and file access scope. Conversations at the same target share working files. Each session retains its draft and reading workset. Worktrees are optional Git checkouts; opened checkouts follow the same cwd-based project model.

Support Pi packages/extensions, resource reload and Pi UI adaptation. Ling ships seven built-in features beside the conversation: todo, access mode (permission system), voice input, MCP services, questions, background tasks and scheduled tasks. Todo, permissions and voice adapt bundled Pi packages (`@juicesharp/rpiv-todo`, `@gotgenes/pi-permission-system`, `@earendil-works/pi-voice`); a copy the user installed through Pi always wins over the bundled one. MCP uses Pi's official built-in extension alongside Codemode and tool search, with Pi's replaceable-extension precedence. Preserve their configuration unless the user explicitly changes it. Questions, background tasks and schedules are Host features whose agent tools the Pi worker registers and forwards. Skills and declarative skins retain their own formats and owners.

Feature state lives under the Ling data home (`~/.ling`, overridable with `LING_HOME`). App data and credentials retain their configured locations. Tool results from Pi extensions carry recorded provenance; a feature adapts results after verifying their source. Unverified results use Pi's rendering.

Preserve the workbench behavior defined in [Design](docs/design.md). Reading worksets belong to the session even when cwd is shared, while file I/O remains project-owned; presentation changes must preserve each draft and viewer's session identity.

## Ownership and imports

- Preserve `contracts` ← `core` ← `host`. Web depends on Contracts; Desktop depends on Contracts and the shell-neutral `node-runtime` primitives only. Core and Host may also use `node-runtime`; that package owns bounded atomic publication, launch log files and process cleanup, and must not import application packages. Core and Host remain shell-agnostic.
- Place feature work in `apps/web/src/features/<name>/` and its owning Host/Core domain, with Web-safe DTOs and pure validation in `packages/contracts/src/`. Native integration belongs to Desktop; HTTP/browser integration belongs to Host or Web's platform adapter.
- Keep Web feature dependencies below `app/` and `features/workspace/`; those directories assemble features. Shared workbench view/controller helpers belong in `components/workbench/`; navigation state shared by multiple screens belongs in `lib/navigation-state.ts`.
- Co-locate single-feature helpers and state. Share across features through `hooks/`, `lib/`, or `components/` only when needed. Session state stays with sessions and shared preferences with their owner; place atoms with the feature that manages their state. A global `atoms/` directory is outside this structure.
- Import owning domain contracts directly. `contracts/api/` composes the clients and native shell API; `contracts/protocol/` owns transport. Domain procedure tables use the transport-neutral `contracts/procedure.ts` primitives. Import implementations directly. `app/` assembles Host domains and infrastructure, which remain independent of that assembly.
- Host request handlers decode requests and call domain functions. Business domain factories receive named dependencies and return handler tables with their owned cleanup; the composition root records that cleanup before registering requests. Project/session coordination receives named lifecycle functions from `app/`; request-handler imports belong in composition roots and the same domain's registration module.
- In application source, `@earendil-works/pi-*` imports belong only to `packages/core/src/pi-sdk/` and actual extension implementations in `packages/builtin-extensions/src/plugins/`. Other application code enters the adapter through `packages/core/src/pi-sdk/entrypoints/`. Use public SDK exports and derive non-exported types within the adapter with `ReturnType`/`Extract`/`Parameters`; import the SDK only by its root specifier, which the Host build maps to the SDK's bundle entry, the one `dist/*` path Ling depends on (see [Architecture](docs/architecture.md)); define Web contracts with browser-safe Ling types. A package the Host loads by file path or `createRequire` must be a declared Host dependency so the staged tree keeps it.
- Validate once at each trust boundary with the owning schema; reuse those schemas across callers. During code or type moves, preserve wire methods, validation and persisted formats. Changes to those behaviors require their own authorized scope and compatibility decision.
- Keep runtime dependencies acyclic, including dynamic imports. Host domain dependencies must also remain acyclic through type-only imports. Contracts and Web must remain browser-safe; Electron belongs to Desktop. Review these boundaries against the changed imports and their callers.

## Implementation conventions

- Write comments in English without module headers; explain behavior with symbol-level JSDoc or inline notes. Chinese belongs in i18n locale data and locale-specific runtime strings (万/亿, 刚刚).
- Keep refactor phase labels and roadmap links inside `docs/`. Code, comments, tests, and development guidance describe current responsibilities and behavior; retain versions that define protocol, storage, API, or dependency compatibility.
- Keep the TS 6 compatibility dependency used by typescript-eslint separate from the TS 7 native compiler (`@typescript/native`). Retain a separate package alias for each compiler.
- Prefer `create*` factories and minimize new dependencies. React components use functions; reuse `apps/web/src/components/error-boundary.tsx` for error boundaries.
- Keep each behavior's implementation and normalized data format together. A one-line helper must convey intent in its name or be inlined. Split files when they mix unrelated concerns; composition roots, registries, and bounded-IO primitives may remain whole.
- Normalize unknown errors through `toError` in `packages/core/src/ling-error.ts` or spawn-aware `toCommandError` in `packages/core/src/command-resolver.ts`. Branch on discriminated unions or error codes. Normalize unknown values with these helpers; message text and inline `instanceof Error` ternaries must not determine control flow.
- Comment numeric bounds, budgets and timing choices when their value changes behavior or has a non-obvious consequence. Explain the consequence that the value controls.
- Add defensive checks for a concrete failure: process exit, broken rendering, unbounded work or retention, lost user data, or unauthorized access. Preserve checks that determine an operation's meaning or isolate third-party code. Base removal on redundant behavior or a verified lack of callers. Share a bound for the same contract; distinct resource budgets and lifecycle fences need their own owners.
- Assign subscriptions, timers, async operations and caches to a component or factory with cleanup. Bound retained data and fence late results to the original project/session, runtime generation, and revision where applicable. Mark deliberate fire-and-forget promises with `void`; failures still need an observable owner.
- Register runtime cleanup when acquiring an owner, including during startup. Stop admission before draining dependencies; startup rollback and normal shutdown must attempt every owned cleanup and preserve all failures. Keep process-wide SDK bindings explicit until their owning state is moved into factories; use production cleanup and factory dependencies for tests. Test-only resets and additional global service locators are prohibited.

## Error handling

Propagate errors or explicit typed failure results through Core, Host, and Desktop; render failures visibly in Web. Report failed reads, parsing, lookups, fetches and RPCs as failures. If a fallback supplies usable data, display the failure alongside it.

- Defaults belong at documented boundaries. Explain why absence is legitimate before defaulting; `noUncheckedIndexedAccess` or an optional type alone does not prove a missing value is expected.
- Return successful entities alongside failure details for the others, and display the result as partial.
- Scope temporary fallbacks to the failure that justified them and clear them when authoritative state arrives. Keep the user's saved choice while a fallback is active.
- Live activity comes from live channels. Use persisted history to display past events.
- Catch at the error owner. Host/Desktop callback roots and deliberate background promises must report failures; request handlers normally let the transport deliver them. Keep catch blocks that isolate extension listeners, attempt every cleanup, or restore state. A Web action that displays an error returns a failure result when its caller needs to branch on the outcome.
- Remove a repeated validation only after tracing every caller to the same validated contract. A process running the SDK can also read disk and execute extensions; validate those inputs regardless of whether the processes share a release version. Preserve output validation, authentication, native path checks, and bounds where resources are consumed.

## Host and native shell

- Desktop owns window lifecycle, menus, OS permissions/dialogs, updater, notifications, and launching/supervising Host. Project, session, Pi, Git, review, terminal, plugin, skill, model, usage, and business persistence stay outside the shell.
- Preload exposes only `ShellApi`. Electron and browsers use the same Web client and authenticated, versioned, runtime-validated Host protocol for business requests; reserve Electron IPC for ShellApi.
- Host binds to loopback by default, authenticates before subscriptions/requests, validates exact origins, and authenticates project-file routes. Non-loopback serving requires explicit remote mode and trusted TLS.
- Desktop navigation is restricted to its exact loopback Host origin. External HTTP(S) links open in the system browser. Validate paths, URLs, enums, and payloads again in Electron main. Browser-only absence uses declared Shell capabilities and typed unsupported errors.
- Host is an independently supervised child running the pinned Node release that staging downloads and verifies. Keep the `runAsNode` fuse disabled and packaged builds refusing remote debugging switches: either would let another local process act with the macOS privacy permissions granted to Ling. Crashes remain visible and restartable; shutdown and update installation must drain Host before exiting the native runtime.

## Pi and session lifecycle

- Embed Pi's SDK directly. Use Pi's default agent directory so normal operation shares credentials, settings, packages, skills, and prompts with the CLI. Run sessions through the embedded SDK.
- Key project state by cwd. Inside the adapter, `getPiServices(cwd)` throws for unopened projects. Honor Pi project trust when loading project configuration and resources.
- Pi package operations from UI and conversations use the shared Host plugin mutation path. Reconcile both project catalogs and live session resources through `packages/host/src/domains/resources/resource-reload.ts`, including after a mutation may have partially written before failing. Preserve mutation and reload outcomes; verify live activation after installation. Value-only settings refresh shared settings snapshots; resource-affecting settings require resource reload.
- Pi command-context replacement (`newSession`, `fork`, `switchSession`) updates Ling's managed session map, subscriptions, dialogs, and sidebar together. `navigateTree` stays in the same session file; a manual Ling fork creates a new sidebar session and preserves the original.
- Persisted session discovery can lag live state; retain in-memory summaries until it catches up. Merge snapshot tails and historical pages through the transcript projection owners, checking runtime/generation/revision and durable message identity. Preserve live messages and loaded tool bodies when an incoming stub is `contentState: "deferred"`; retain completed pages if a later read fails. Merge snapshots into both empty and populated message state.
- Prefer SDK model/thinking, `steer`, `followUp`, fork, and replacement features and session-manager primitives inside the adapter. Unsupported Pi TUI/editor calls throw typed unsupported errors; advertise capabilities that the adapter fully implements.

## Renderer

- Treat message roles as an open union and narrow known roles only. Sidebar busy/queue status tracks every session wired this run. Use immutable React/Jotai updates.
- Keep message keys and interpolation names aligned across all supported application and built-in plugin locales. Reuse the existing locale contract check; inspect wrapping and truncation in the actual UI.
- Use `motion/react` under `MotionConfig reducedMotion="user"`, give CSS animations a `motion-reduce:` branch, and animate `transform`/`opacity`. Travelling selection indicators share one `layoutId` per group.
- Follow Design for shared control styling and skin tokens. Synchronize theme behavior across `apps/web/public/theme-init.js`, `apps/web/src/lib/appearance/use-theme.ts`, and the Desktop shell.
- `components/ui/` owns shared controls, menu geometry, focus, typography and surfaces. Feature folders combine these shared controls with business state. Host feature pages and Pi UI adaptations use those same controls; keep shared helpers for business state and navigation. See [Design](docs/design.md) for the component map and supported customization boundaries.
- Preserve transcript geometry, reading position, and conversation-scoped artwork when changing workspace presentation; zero-sized hidden layouts can corrupt virtualization. Make inactive views inert and remove them from accessibility navigation.
- Workspace images use authenticated Host routes. CSP permits `img-src 'self' data: blob: https:`; arbitrary `http:` image origins are rejected. Route Markstream image nodes through `MarkdownImage` so project-path validation and authenticated image loading remain owned by Ling.

## Cross-platform behavior

- Use `node:path` for OS paths in Host/Desktop. Web path-boundary checks must recognize both slash directions. Slashes remain valid inside `provider/modelId` and npm `@scope/pkg` identities.
- Use `isShortcutModifier` for events, `shortcut()` for display, and i18n interpolation such as `{{modEnter}}`; derive modifier labels from the platform.

## Skills and maintenance workflows

`.agents/skills/` contains guidance distributed with the source checkout. Application packaging includes `builtin-skills/<name>/SKILL.md` for end users and excludes `.agents/skills/`. Keep both tiers English and read [skill-authoring](.agents/skills/skill-authoring/SKILL.md) before editing either.

Use [commit](.agents/skills/commit/SKILL.md) for staging/commit work, [release](.agents/skills/release/SKILL.md) for version/build/tag/publication work, [interface-acceptance](.agents/skills/interface-acceptance/SKILL.md) for UI/UE/UX audits, responsiveness fixes and real interface retesting, and [update-pi-dependency](.agents/skills/update-pi-dependency/SKILL.md) for SDK upgrades or compatibility reviews. Run [maintain-pi-dependencies](.agents/skills/maintain-pi-dependencies/SKILL.md) before every release candidate and for bundled Todo, permission, voice or official MCP updates. Follow the user's requested endpoint; executing a workflow's mutations requires the user's authorization for those actions.

## Verification

- Select tests by the behavior and failure impact of the change. A new test should protect a concrete invariant or reproduce a confirmed bug. Review architecture and test selection through this file and code review. Do not add coverage quotas, one-test-file-per-source rules, architecture tests or custom enforcement scripts.

Add or extend co-located Vitest tests when the change affects these behaviors:

| Behavior | Worth preserving in tests |
| --- | --- |
| Protocol and domain validation | Ling-specific compatibility, normalization, cross-field rules, path semantics, and malformed data that could change an operation's meaning. Test Ling's validation behavior at the input parser. |
| Async ownership and queues | Cancellation, late results, generation/revision fencing, ordering, capacity release, and cleanup after failure. |
| Session projection and draft submission | Durable identity, history/live merging, deferred content, retaining completed pages after a later read fails, and preserving unsent input on failure. |
| Persistence and retained data | Atomic publication, migration, partial reads, cache invalidation, bounded retention, and independent owners. Use real temporary files when filesystem behavior matters. |
| External data interpretation | Provider quota parsing and other nontrivial adapters with sanitized representative inputs. Reuse the existing locale key/interpolation check when changing locale data. |

Use existing checks or manual review for these changes by default:

- Type declarations, DTO aliases, constants, or schemas that only restate library primitives.
- Direct forwarding, simple composition wiring, file moves, renames, or extracting an unchanged helper. Run relevant existing tests when ownership or callers could be affected.
- UI components, styles, layout, icons, copy and interaction rendering. Verify these in the real application with CDP or Computer Use, including first-open and repeated interaction states. Do not add DOM snapshots, component rendering tests, class-name assertions or mocked animation/layout tests. Keep non-UI protocol, persistence and state-machine coverage with its behavior owner.
- Documentation, agent instructions, skill prose, and routine configuration edits. Review references and use the affected tool when its configuration changes.
- Third-party behavior already guaranteed by its public contract, or speculative failure cases unsupported by the actual interface or observed behavior.

Keep test ownership and verification proportionate:

- Prefer extending the existing behavior owner's suite. Keep helper coverage in that behavior's suite. Keep useful regression tests; consolidate or remove tests only when their assertions are demonstrably redundant or merely mirror implementation details.
- Keep fixtures inline and isolate each test's state; use owned cleanup or module isolation for legacy globals. Filesystem tests use [temporaryDirectory](test/temporary-directory.ts) and remove their child directories after draining owned resources. Temporary research, benchmarks, probes, and synthetic runtime data stay outside the repository.
- Use focused lint/format checks, affected TypeScript projects, and relevant existing tests for a local change. `pnpm verify` is the combined lint, format, typecheck, and test command used by CI; use it for broad changes and release candidates, according to the scope of the change. Documentation-only changes do not require a full suite or starting dev.
- Run a real `pnpm dev` smoke when runtime integration changes. Build or dependency-tooling changes need the affected build/tool check; select runtime checks that exercise the changed build or tool.
- Exercise model turns, approvals, resume, replacement, reload and process cleanup in the running application. SDK, network, React layout, Electron, worker, PTY and filesystem-watcher mocks count as unit checks separately from runtime acceptance.
- Changes that affect session lifecycle, SDK runtime/project services, extension UI interaction, or session execution require a real model turn and actual tool-approval flow. Exercise resume, replacement, reload, and cleanup when affected; directory membership or an unchanged code move alone does not require these checks.
- Use the isolated smoke workflow in [Development](docs/development.md), which owns commands, credentials, staging and cleanup.
- Installer staging, target architecture, signing, and artifact checks belong to the release skill.
- Verify the actual candidate and report the checks performed and remaining gaps. Build, runtime smoke, local commit, pushed refs, and public release are distinct results. Reuse previous checks only while their relevant inputs and environment remain unchanged.
