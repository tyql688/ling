# Pi upgrade checklist

Use this reference for the published changes in the selected audit range, including a coverage audit with unchanged dependency pins. Select checks for the affected surfaces and trace their APIs in the current checkout. [Architecture](../../../../docs/architecture.md) owns the directory and runtime map; the [parent skill](../SKILL.md) owns source auditing, dependency updates, and verification steps.

## Record feature coverage

Keep a concise table with the task's evidence, outside application source. Use one row per material capability or tightly related fix group. Record the audit baseline and published target independently of the installed version.

| Published change and source | Pi behavior and purpose | Ling path and user interaction | Decision | Coverage and evidence |
| --- | --- | --- | --- | --- |
| Release, source symbol and artifact declaration or executable | What the capability does, including changed semantics | Owning module, transport/data mapping and visible control, command or result | `adapt`, `expose`, `inherited` or `defer` | Existing or newly implemented behavior, checks actually run, remaining gap or concrete boundary |

Trace capability discovery, configuration, execution, live events, result fields, failures, cancellation and persisted history where applicable. Trace each field through Core and its Web consumer, then verify its displayed value or effect. Separate source evidence from runtime evidence. Reuse prior acceptance only when its candidate and environment remain applicable.

The table must distinguish an implemented path from an unresolved gap. Stable capabilities within an existing Ling feature receive an implementation decision; deferral requires a supported reason from the decision rules below, including when version pins remain unchanged. Experimental capabilities already exposed through public SDK contracts still need an explicit coverage assessment. TUI-specific behavior maps to the equivalent Ling interaction where one exists; terminal rendering machinery stays with Pi's TUI.

## Classify the change

- `adapt`: Ling calls or normalizes a changed stable API and must change to remain correct.
- `expose`: a stable capability belongs to an existing Ling feature and needs a contract/UI path.
- `inherited`: the published implementation reaches an existing Ling path without a Ling source change, including capabilities already integrated in an earlier bump; verify that path and distinguish runtime evidence from source inspection.
- `defer`: Ling has no supported public runtime path, the behavior belongs exclusively to the terminal interface, or it requires a product decision under [AGENTS.md](../../../../AGENTS.md). State the concrete boundary and what evidence would reopen it. Assess experimental capabilities against the same runtime and product criteria.

## Select compatibility checks

| Changed upstream surface | Evidence to collect |
| --- | --- |
| Package exports and SDK construction | Compare root exports and declaration signatures with Ling's imports, then initialize the SDK from the published artifact. Check type identity and runtime initialization, including newly required dependencies. |
| Agent/session events | Exercise changed event sequences through a completed, failed, or aborted turn as applicable. Confirm Web busy/retry/queue state settles and reopening persisted history does not invent live activity. |
| Persisted entries and message shapes | Resume sessions containing valid old and new shapes. Check that normalization, transport, and rendering preserve supported fields and tolerate unknown roles at open-union boundaries. |
| Transcript paging, cached projections, and tool details | Reopen a cached session, load historical pages, and expand tool results. Complete a live tool call while its result is expanded: the final snapshot must preserve the loaded body and entry identity without a second detail read. A failed later page must retain completed pages. Apply the cache checks below when projection behavior changes. |
| Session replacement, queue, fork, compaction, reload | Exercise affected commands and check session identity, subscriptions, pending dialogs, sidebar state, and queued messages. Distinguish in-file tree navigation from a manual fork. For abort/compaction changes, check provider connection closure, operation settlement, busy/retry cleanup, and unwanted persisted summaries. |
| Settings and configuration refresh | Write and read back changed stable settings through Pi's canonical persistence path, then verify live value refresh or resource reload as appropriate. Preserve unknown fields and keep inferred runtime defaults out of saved user configuration. |
| Models, providers, credentials | Compare the installed catalog with the upstream generator. Check provider identity, thinking levels, context limits, and compatibility metadata after projection. Capture actual provider payloads when serialization changes. Editable definitions must belong to the accepted runtime generation; rejected files and extension-owned models must not supply one another's definitions or expose secrets. |
| Non-chat models in Codemode | Discover available classifier and image models through the session registry, invoke changed public operations through an actual script, and verify errors, output images, preview loading, tool usage and session totals. Image parts must remain previewable alongside extension-rendered text and in persisted results after restart. Distinguish a live provider result from a controlled fixture, and never count a model-generated script error as an SDK failure without inspecting the script. |
| Interactive provider authentication | Exercise method selection, browser/copy-code or device-code prompts, cancellation and re-entry through Ling's login dialog. Preserve provider-supplied choices and distinguish account login from subscription login using provider metadata. Record external authorization separately from reaching the correct prompt. |
| Pi package installation, removal, update | Exercise affected operations from both settings and the conversation tool. Check source/scope identity, trust, cancellation, partial writes, and catalog/session reload across open projects. Verify installation, resource discovery, and live activation separately. |
| Extension API and Pi UI adaptation | Exercise changed APIs with actual Pi extensions, including Ling's built-ins where affected. Verify supported dialogs, inputs, and UI snapshots in Ling; check typed unsupported errors for TUI/editor APIs the adapter cannot provide. |
| Built-in tools and custom rendering | Check tool names, results, cwd behavior, and collapsed/expanded call and result snapshots. Inspect rendered output even when execution succeeds. Changed upstream renderers may require process-global initialization despite accepting an explicit theme. |
| Composer completion and cancellation | Exercise rapid edits and atomic paste separately. Confirm autocomplete and command-argument reads coalesce, only dispatched unsettled operations cancel, and late results cannot update another session or an unmounted view. |
| Skills, project trust, resource loading | Check discovery, diagnostics, project trust, switches, source scope, shadowing, and packaged resources against the target Pi behavior. Use [skill-authoring](../../skill-authoring/SKILL.md) for skill content and loading changes. |
| Network/proxy behavior | Exercise affected provider, model-refresh, login, and quota requests with the intended network configuration. Confirm an inherited fix reaches the actual request path. |
| Host packaging and standalone runtime | Inspect new runtime/native dependencies for externalization and pruning. Import Pi's bundle with bundled Node from the staged Host dependency tree on the target architecture. |

## Check changes that types cannot prove

For changed fields, trace representative values through every request/result validator, normalizer, projection, and Web consumer. Check nullable values accepted as `unknown`, valid fields silently dropped by projections, removed events still assumed by callers, and changed semantics behind unchanged method signatures. Use the owning shared schema when a boundary reuses validation. User-visible changes need matching keys and interpolation names in every supported application and built-in plugin locale.

Transcript cache identity includes the Pi version. When a Ling-only normalization or rendering change needs to invalidate existing projections, advance `TRANSCRIPT_PROJECTION_REVISION` in `packages/core/src/pi-sdk/session/runtime-projection.ts`. Verify a pre-change cached session on restart without rewriting its original entries.

## Canonical ownership checks

For configuration or runtime changes, trace each setting from its raw global/project expression through SettingsManager, the live session and its visible control. Verify override reset, unknown sibling preservation, externally changed revisions, unsaved draft navigation, terminal-only fields and resource-versus-value refresh. A displayed default must not be written back unless the user changes it.

Use a real session to verify native shell prefixes/timeouts, queue delivery settings, scoped/all-model selection and custom session-directory discovery. Check that catalog refresh preserves custom definitions. In Session Details, change an active tool, label and navigate a tree entry, inspect the system prompt and extension flags, export and import JSONL, and verify managed replacement and draft ownership. Submit `/compact` with instructions, `/reload` and `/session` through the composer to verify command entry as well as execution.

Exercise global and project `builtin:mcp` filters, installed extension precedence, native skill path filters and legacy migration. Check the actual permission source after reload, including deferred application. Global `project_trust` handlers must run through the SDK loading stage without a second factory initialization, and protected project resources must remain gated. Treat a native provider or coding-agent keybinding export as available only after verifying it in the exact published package artifact. Check configured custom-panel keybindings against Pi TUI and test that the final staged dependency graph resolves them.
