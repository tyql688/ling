# Pi upgrade checklist

Use this reference after identifying the published upstream delta. Select checks for the changed surfaces and trace the affected APIs in the current checkout. [Architecture](../../../../docs/architecture.md) owns the directory and runtime map; the [parent skill](../SKILL.md) owns source auditing, dependency updates, and verification steps.

## Classify the change

- `adapt`: Ling calls or normalizes a changed stable API and must change to remain correct.
- `expose`: a stable capability belongs to an existing Ling vertical and needs a contract/UI path.
- `inherited`: the bump activates a fix through the existing integration without a Ling source change; verify that it reaches the affected behavior or build boundary.
- `defer`: the feature is experimental, TUI-specific, duplicates an existing integration, or needs a product decision under [AGENTS.md](../../../../AGENTS.md). State the reason and what evidence would reopen it.

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
| Pi package installation, removal, update | Exercise affected operations from both settings and the conversation tool. Check source/scope identity, trust, cancellation, partial writes, and catalog/session reload across open projects. Verify installation, resource discovery, and live activation separately. |
| Extension API and Pi UI adaptation | Exercise changed APIs with actual Pi extensions, including Ling's built-ins where affected. Verify supported dialogs, inputs, and UI snapshots in Ling; check typed unsupported errors for TUI/editor APIs the adapter cannot provide. |
| Built-in tools and custom rendering | Check tool names, results, cwd behavior, and collapsed/expanded call and result snapshots. Inspect rendered output even when execution succeeds. Changed upstream renderers may require process-global initialization despite accepting an explicit theme. |
| Composer completion and cancellation | Exercise rapid edits and atomic paste separately. Confirm autocomplete and command-argument reads coalesce, only dispatched unsettled operations cancel, and late results cannot update another session or an unmounted view. |
| Skills, project trust, resource loading | Check discovery, diagnostics, project trust, switches, source scope, shadowing, and packaged resources against the target Pi behavior. Use [skill-authoring](../../skill-authoring/SKILL.md) for skill content and loading changes. |
| Network/proxy behavior | Exercise affected provider, model-refresh, login, and quota requests with the intended network configuration. Confirm an inherited fix reaches the actual request path. |
| Host packaging and standalone runtime | Inspect new runtime/native dependencies for externalization and staging. Import Pi with bundled Node from the staged Host dependency tree on the target architecture. |

## Check changes that types cannot prove

For changed fields, trace representative values through every request/result validator, normalizer, projection, and Web consumer. Check nullable values accepted as `unknown`, valid fields silently dropped by projections, removed events still assumed by callers, and changed semantics behind unchanged method signatures. Use the owning shared schema when a boundary reuses validation. User-visible changes need matching keys and interpolation names in every supported application and built-in plugin locale.

Transcript cache identity includes the Pi version. When a Ling-only normalization or rendering change needs to invalidate existing projections, advance `TRANSCRIPT_PROJECTION_REVISION` in `packages/core/src/pi-sdk/session/runtime-projection.ts`. Verify a pre-change cached session on restart without rewriting its original entries.
