# Ling Agent Instructions

Keep this file focused on product boundaries, non-obvious development rules, and test selection. Use current source and configuration as implementation evidence. [Architecture](docs/architecture.md) maps code owners, [Design](docs/design.md) defines interface behavior, [Processes](docs/processes.md) defines the process model and diagnostics, [Development](docs/development.md) describes local runs, and repository skills own specialized maintenance workflows. Update the owning document instead of duplicating its details here.

## Product boundary

Ling is a GUI/Web host for Pi: projects and Pi sessions, change review/diff, models, Pi package management, usage stats, and settings. A conversation requires an open project. Project cwd is the product boundary; worktrees are optional Git operations, not a project/workspace hierarchy.

Support Pi packages/extensions, resource reload and Pi UI adaptation. Ling ships seven built-in features beside the conversation: todo, access mode (permission system), voice input, MCP services, questions, background tasks and scheduled tasks. Todo, permissions, voice and MCP adapt bundled Pi packages (`@juicesharp/rpiv-todo`, `@gotgenes/pi-permission-system`, `@earendil-works/pi-voice`, `pi-mcp-adapter`); a copy the user installed through Pi always wins over the bundled one. Preserve their configuration unless the user explicitly changes it. Questions, background tasks and schedules are Host features whose agent tools the Pi worker registers and forwards. Skills and declarative skins retain their own formats and owners.

Feature state lives under the Ling data home (`~/.ling`, overridable with `LING_HOME`) and never moves existing app data or credentials. Tool results from Pi extensions carry recorded provenance; a feature projects only results whose provenance it verified and otherwise keeps Pi's original rendering.

Preserve the workbench behavior defined in [Design](docs/design.md). Reading worksets belong to the session even when cwd is shared, while file I/O remains project-owned; presentation changes must not transfer a draft or viewer to another session.

## Ownership and imports

- Preserve `contracts` ← `core` ← `host`. Web depends on Contracts; Desktop depends on Contracts and the shell-neutral `node-runtime` primitives only. Core and Host may also use `node-runtime`; that package owns bounded atomic publication, launch log files and process cleanup, and must not import application packages. Core and Host remain shell-agnostic.
- Place feature work in `apps/web/src/features/<name>/` and its owning Host/Core domain, with Web-safe DTOs and pure validation in `packages/contracts/src/`. Native integration belongs to Desktop; HTTP/browser integration belongs to Host or Web's platform adapter.
- Web features must not import the `app/` or `features/workspace/` composition roots. Shared workbench view/controller helpers belong in `components/workbench/`; navigation state shared by multiple screens belongs in `lib/navigation-state.ts`.
- Co-locate single-feature helpers and state. Share across features through `hooks/`, `lib/`, or `components/` only when needed. Session state stays with sessions and shared preferences with their owner; do not recreate a global `atoms/` directory.
- Import owning domain contracts directly. `contracts/api/` composes the clients and native shell API; `contracts/protocol/` owns transport. Domain procedure tables use the transport-neutral `contracts/procedure.ts` primitives. Avoid pass-through barrels, facades, and forwarding files. Host domains and infrastructure must not depend on `app/`, the composition root.
- Host request handlers adapt transport to domain owners. Business domain factories receive named dependencies and return handler tables with their owned cleanup; the composition root records that cleanup before registering requests. Project/session coordination receives explicit lifecycle ports from `app/`; domain owners must not import request-handler modules. Only composition roots and same-domain handler registration may import those modules.
- In application source, `@earendil-works/pi-*` imports belong only to `packages/core/src/pi-sdk/` and actual extension implementations in `packages/builtin-extensions/src/plugins/`. Other application code enters the adapter through `packages/core/src/pi-sdk/entrypoints/`. Use public SDK exports and derive non-exported types within the adapter with `ReturnType`/`Extract`/`Parameters`; never import Pi `dist/*` internals or leak SDK types into Web contracts.
- Validate once at each trust boundary with the owning schema; reuse schemas across boundaries instead of repeating checks within a layer. Moving code or types does not authorize changing wire methods, validation, or persisted formats. Keep compatibility decisions explicit.
- Keep runtime dependencies acyclic, including dynamic imports. Host domain dependencies must also remain acyclic through type-only imports. Contracts and Web must remain browser-safe; Electron belongs to Desktop. Review these boundaries against the changed imports and their callers.

## Implementation conventions

- Write comments in English without module headers; explain behavior with symbol-level JSDoc or inline notes. Chinese belongs in i18n locale data and locale-specific runtime strings (万/亿, 刚刚).
- Keep refactor phase labels and roadmap links inside `docs/`. Code, comments, tests, and development guidance describe current responsibilities and behavior; retain versions that define protocol, storage, API, or dependency compatibility.
- Keep the TS 6 compatibility dependency used by typescript-eslint separate from the TS 7 native compiler (`@typescript/native`). Do not collapse their package aliases into one version.
- Prefer `create*` factories and minimize new dependencies. React components use functions; reuse `apps/web/src/components/error-boundary.tsx` for error boundaries.
- Give each behavior one owner and one normalized contract. A one-line helper must convey intent in its name or be inlined. Split files when they mix unrelated concerns; composition roots, registries, and bounded-IO primitives may remain whole.
- Normalize unknown errors through `toError` in `packages/core/src/ling-error.ts` or spawn-aware `toCommandError` in `packages/core/src/command-resolver.ts`. Branch on discriminated unions or error codes, never message text or inline `instanceof Error` ternaries.
- Comment numeric bounds, budgets and timing choices when their value changes behavior or has a non-obvious consequence. Do not narrate self-evident arithmetic or language constants.
- Add defensive checks for a concrete failure: process exit, broken rendering, unbounded work or retention, lost user data, or unauthorized access. Preserve checks that determine an operation's meaning or isolate third-party code. Counts of checks, constants, files, or branches are not deletion targets. Share a bound for the same contract; distinct resource budgets and lifecycle fences need their own owners.
- Give subscriptions, timers, async operations, and caches an explicit owner and cleanup path. Bound retained data and fence late results to the original project/session, runtime generation, and revision where applicable. Mark deliberate fire-and-forget promises with `void`; failures still need an observable owner.
- Register runtime cleanup when acquiring an owner, including during startup. Stop admission before draining dependencies; startup rollback and normal shutdown must attempt every owned cleanup and preserve all failures. Keep process-wide SDK bindings explicit until their owning state is moved into factories; do not add test-only resets or another global service locator.

## Failure semantics

Propagate errors or explicit typed failure results through Core, Host, and Desktop; render failures visibly in Web. Never turn a failed read, parse, lookup, fetch, or RPC into an authoritative empty success. Defaults and fallbacks must not hide failures.

- Defaults belong at documented boundaries. Explain why absence is legitimate before defaulting; `noUncheckedIndexedAccess` or an optional type alone does not prove a missing value is expected.
- A failed entity must not erase unrelated complete results. Return the successful subset with explicit partial/failure information and keep that distinction visible.
- Scope temporary fallbacks to the failure that justified them and clear them when authoritative state arrives. A fallback must not rewrite the user's saved choice.
- Live activity comes from live channels. Persisted history describes what happened, not what is still running.
- Catch at the error owner. Host/Desktop callback roots and deliberate background promises must report failures; request handlers normally let the transport deliver them. Keep catch blocks that isolate extension listeners, attempt every cleanup, or restore state. A Web action that already owns a visible error must not rethrow solely to make its caller swallow the same failure; return a failure result when the caller needs to branch on it.
- Remove a repeated validation only after tracing every caller to the same validated contract. A process running the SDK can also read disk and execute extensions; shared release versions alone do not prove all of its inputs are trusted. Preserve output validation, authentication, native path checks, and bounds where resources are consumed.

## Host and native shell

- Desktop owns window lifecycle, menus, OS permissions/dialogs, updater, notifications, and launching/supervising Host. Project, session, Pi, Git, review, terminal, plugin, skill, model, usage, and business persistence stay outside the shell.
- Preload exposes only `ShellApi`. Electron and browsers use the same Web client and authenticated, versioned, runtime-validated Host protocol for business requests; Electron IPC must not become a parallel protocol.
- Host binds to loopback by default, authenticates before subscriptions/requests, validates exact origins, and exposes no unauthenticated project-file route. Non-loopback serving requires explicit remote mode and trusted TLS.
- Desktop navigation is restricted to its exact loopback Host origin. External HTTP(S) links open in the system browser. Validate paths, URLs, enums, and payloads again in Electron main. Browser-only absence uses declared Shell capabilities and typed unsupported errors.
- Host is an independently supervised child. Crashes remain visible and restartable; shutdown and update installation must drain Host before exiting the native runtime.

## Pi and session lifecycle

- Embed Pi's SDK directly. Use Pi's default agent directory so normal operation shares credentials, settings, packages, skills, and prompts with the CLI. A separate Pi CLI process or local server must not become Ling's runtime implementation.
- Key project state by cwd. Inside the adapter, `getPiServices(cwd)` throws for unopened projects. Honor Pi project trust when loading project configuration and resources.
- Pi package operations from UI and conversations use the shared Host plugin mutation path. Reconcile both project catalogs and live session resources through `packages/host/src/domains/resources/resource-reload.ts`, including after a mutation may have partially written before failing. Preserve mutation and reload outcomes; installation alone does not prove live activation. Value-only settings refresh shared settings snapshots; resource-affecting settings require resource reload.
- Pi command-context replacement (`newSession`, `fork`, `switchSession`) updates Ling's managed session map, subscriptions, dialogs, and sidebar together. `navigateTree` stays in the same session file; a manual Ling fork creates a new sidebar session and preserves the original.
- Persisted session discovery can lag live state; retain in-memory summaries until it catches up. Merge snapshot tails and historical pages through the transcript projection owners, checking runtime/generation/revision and durable message identity. Preserve live messages and loaded tool bodies when an incoming stub is `contentState: "deferred"`; retain completed pages if a later read fails. Do not gate all snapshot merging on an empty message atom.
- Prefer SDK model/thinking, `steer`, `followUp`, fork, and replacement features and session-manager primitives inside the adapter. Unsupported Pi TUI/editor calls throw typed unsupported errors; do not silently no-op or advertise a partially simulated capability.

## Renderer

- Treat message roles as an open union and narrow known roles only. Sidebar busy/queue status tracks every session wired this run. Use immutable React/Jotai updates.
- Keep message keys and interpolation names aligned across all supported application and built-in plugin locales. Reuse the existing locale contract check; inspect wrapping and truncation in the actual UI.
- Use `motion/react` under `MotionConfig reducedMotion="user"`, give CSS animations a `motion-reduce:` branch, and animate `transform`/`opacity`. Travelling selection indicators share one `layoutId` per group.
- Follow Design for shared control styling and skin tokens. Synchronize theme behavior across `apps/web/public/theme-init.js`, `apps/web/src/lib/appearance/use-theme.ts`, and the Desktop shell.
- `components/ui/` owns shared controls, menu geometry, focus, typography and surfaces. Feature folders own business composition, not alternate control kits. Host feature pages and Pi UI adaptations use those same controls; keep their shared helpers limited to business state and navigation. See [Design](docs/design.md) for the component map and supported customization boundaries.
- Preserve transcript geometry, reading position, and conversation-scoped artwork when changing workspace presentation; zero-sized hidden layouts can corrupt virtualization. Inactive views must not receive focus or remain exposed to accessibility navigation.
- Workspace images use authenticated Host routes. CSP permits `img-src 'self' data: blob: https:` without arbitrary `http:`. Route Markstream image nodes through `MarkdownImage` so project-path validation and authenticated image loading remain owned by Ling.

## Cross-platform behavior

- Use `node:path` for OS paths in Host/Desktop. Web path-boundary checks must recognize both slash directions. Slashes remain valid inside `provider/modelId` and npm `@scope/pkg` identities.
- Use `isShortcutModifier` for events, `shortcut()` for display, and i18n interpolation such as `{{modEnter}}`; do not hard-code the Command symbol.

## Skills and maintenance workflows

`.agents/skills/` contains repository development guidance and is never packaged. `builtin-skills/<name>/SKILL.md` ships to end users. Keep both tiers English and read [skill-authoring](.agents/skills/skill-authoring/SKILL.md) before editing either.

Use [commit](.agents/skills/commit/SKILL.md) for staging/commit work, [release](.agents/skills/release/SKILL.md) for version/build/tag/publication work, and [update-pi-dependency](.agents/skills/update-pi-dependency/SKILL.md) for SDK upgrades or compatibility reviews. Run [maintain-pi-dependencies](.agents/skills/maintain-pi-dependencies/SKILL.md) before every release candidate and for bundled Todo, permission, voice or MCP package updates. Follow the user's requested endpoint; editing a workflow does not authorize executing its mutations.

## Verification

- Select tests by behavior and failure impact, not by file count or whether a function is pure. A new test should protect a concrete invariant or reproduce a confirmed bug. Do not add coverage quotas, one-test-file-per-source rules, architecture tests, or custom enforcement scripts; architecture and test-selection policy belong in this file and code review.

Add or extend co-located Vitest tests when the change affects these behaviors:

| Behavior | Worth preserving in tests |
| --- | --- |
| Protocol and domain validation | Ling-specific compatibility, normalization, cross-field rules, path semantics, and malformed data that could change an operation's meaning. Test the owning boundary, not every schema field or Zod primitive. |
| Async ownership and queues | Cancellation, late results, generation/revision fencing, ordering, capacity release, and cleanup after failure. |
| Session projection and draft submission | Durable identity, history/live merging, deferred content, retaining completed pages after a later read fails, and preserving unsent input on failure. |
| Persistence and retained data | Atomic publication, migration, partial reads, cache invalidation, bounded retention, and independent owners. Use real temporary files when filesystem behavior matters. |
| External data interpretation | Provider quota parsing and other nontrivial adapters with sanitized representative inputs. Reuse the existing locale key/interpolation check when changing locale data. |

Do not add test files by default for:

- Type declarations, DTO aliases, constants, or schemas that only restate library primitives.
- Direct forwarding, simple composition wiring, file moves, renames, or extracting an unchanged helper. Run relevant existing tests when ownership or callers could be affected.
- UI components, styles, layout, icons, copy and interaction rendering. Verify these in the real application with CDP or Computer Use, including first-open and repeated interaction states. Do not add DOM snapshots, component rendering tests, class-name assertions or mocked animation/layout tests. Keep non-UI protocol, persistence and state-machine coverage with its behavior owner.
- Documentation, agent instructions, skill prose, and routine configuration edits. Review references and use the affected tool when its configuration changes.
- Third-party behavior already guaranteed by its public contract, or speculative failure cases unsupported by the actual interface or observed behavior.

Keep test ownership and verification proportionate:

- Prefer extending the existing behavior owner's suite. Helpers serving that behavior do not each need a sibling test file. Keep useful regression tests; consolidate or remove tests only when their assertions are demonstrably redundant or merely mirror implementation details.
- Keep fixtures inline and isolate each test's state; use owned cleanup or module isolation for legacy globals. Filesystem tests use [temporaryDirectory](test/temporary-directory.ts) and remove their child directories after draining owned resources. Temporary research, benchmarks, probes, and synthetic runtime data stay outside the repository.
- Use focused lint/format checks, affected TypeScript projects, and relevant existing tests for a local change. `pnpm verify` is the combined lint, format, typecheck, and test command used by CI; use it for broad changes and release candidates, not as a mandatory step for every edit or commit. Documentation-only changes do not require a full suite or starting dev.
- Run a real `pnpm dev` smoke when runtime integration changes. Build or dependency-tooling changes need the affected build/tool check; unrelated model turns do not add evidence for them.
- Do not replace runtime acceptance with SDK, network, React layout, Electron, worker, PTY, or filesystem-watcher mocks. Real model turns, approvals, resume, replacement, reload, and process cleanup remain smoke checks.
- Changes that affect session lifecycle, SDK runtime/project services, extension UI interaction, or session execution require a real model turn and actual tool-approval flow. Exercise resume, replacement, reload, and cleanup when affected; directory membership or an unchanged code move alone does not require these checks.
- Use the isolated smoke workflow in [Development](docs/development.md), which owns commands, credentials, staging and cleanup.
- Installer staging, target architecture, signing, and artifact checks belong to the release skill.
- Verify the actual candidate and report the checks performed and remaining gaps. Build, runtime smoke, local commit, pushed refs, and public release are distinct results. Reuse previous checks only while their relevant inputs and environment remain unchanged.
