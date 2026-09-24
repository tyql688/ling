# Bundled Pi extension upgrade checklist

Use this after establishing the published current-to-target delta in the [parent workflow](../SKILL.md). Select affected rows and record concrete before/after behavior; do not claim unexecuted checks. [Architecture](../../../../docs/architecture.md) owns the runtime map and [AGENTS.md](../../../../AGENTS.md) owns product boundaries and test selection.

Use the `adapt`, `expose`, `inherited` and `defer` decision rules in the [Pi upgrade checklist](../../update-pi-dependency/references/upgrade-checklist.md). The rows below add extension-specific migration and acceptance checks.

## Shared extension behavior

| Changed surface | Migration and acceptance evidence |
| --- | --- |
| Extension exports and dependency layout | Load the exact published `pi.extensions` entries through the installed SDK. Inspect transitive runtime dependencies and staged resources, not just type declarations or source archives. |
| Loading, identity and versions | Confirm bundled identity, supported recorded provenance and user-installed precedence. An unrelated extension with the same tool name must retain Pi rendering and must not gain Ling's trusted projection or automatic mutations. |
| Enable/disable and resource reload | Change the built-in feature switch while idle and busy. Verify admission and deferred reload, preserved configuration, no duplicate registrations and no obsolete tools after settlement/restart. A Ling switch must not uninstall the user's separate Pi package. |
| SDK events, queues and replacement | Exercise changed start/end/settled behavior, cancellation, retry and affected fork/tree/replacement flows. Check session identity, busy state, dialogs and cleanup across reload; no continuation may escape to another session. |
| UI and configuration | Inspect actual dialogs, selections, keyboard focus, localized copy and read-only/history states in Web and Desktop. Unsupported TUI APIs must remain typed failures. Reuse upstream files and Ling controls rather than creating another settings format or UI kit. |

## Todo

| Changed surface | Migration and acceptance evidence |
| --- | --- |
| Actions, arguments and details | Use original create/list/get/update/delete/clear actions where affected. Verify explicit status changes, dependency IDs, task metadata, errors and deleted-item handling through schema, projection and UI. Preserve valid old sessions and visible failures. |
| Guidance and task finishing | Read actual tool guidance and prompt integration. Complete work with evidence, leave blocked/failed/cancelled/deferred work unfinished, and exercise a missed status update. Verify automatic reconciliation is bounded, does not run after abort/error or displace queued messages, and uses the original Todo tool. Inspect new upstream finishing hooks for duplicate follow-ups before removing Ling behavior. |
| State and replay | Create tasks, reload resources, resume/restart and navigate or fork the session where affected. Verify original upstream replay, branch isolation and the latest verified details. A completed turn alone must not mark tasks complete. |
| Rendering and ownership | Verify compact progress, expanded results, the Todo page and manual progress check agree with persisted tool results. Test bundled and supported Pi-installed copies; preserve original rendering for unsupported versions or unknown provenance. |

## Permission system

| Changed surface | Migration and acceptance evidence |
| --- | --- |
| Rule syntax and precedence | Compare actual rule parsing, matching order, defaults, tool-name normalization and new namespaces such as MCP. Exercise representative overlapping allow/ask/deny rules, including the breaking precedence change when present. Never rewrite user rules silently. |
| Approval lifecycle | Run a real allowed tool, approve and deny prompted calls, cancel a pending request and verify no execution after denial/cancellation. Confirm repeated approvals, session replacement and reload do not leave stale dialogs or grant another call's decision. |
| Activation and tool filtering | Verify project/default activation, the master switch and full-access transitions. Tools hidden or filtered by permission mode must return when that mode is removed. Preserve the saved preference when the master switch is off. |
| Files and inheritance | Test missing/global/project rule files according to upstream semantics, malformed configuration and partial write failures. Keep failures visible and existing contents intact. Verify the exact file opened by Ling matches the one upstream reads. |
| Parser and native assets | Inspect published WASM files, `tree-sitter-bash` requirements, build policy and executable asset resolution. Run a representative shell command through the staged extension on the available target; document untested platforms and changed package size. |

## Voice

| Changed surface | Migration and acceptance evidence |
| --- | --- |
| Published source and SDK resolution | Audit the version-specific source adapter before widening supported versions. Resolve the real package directory and embedded public SDK for both the bundled copy and a Pi-installed copy without its own SDK peers. Unknown versions must retain original commands and report unsupported native adaptation visibly. |
| Settings, catalogs and models | Reuse upstream configuration and model caches. Verify explicit model download, cancellation, language and Chinese-output settings, and preserved shortcut/device preferences. Opening Ling must not trigger migration or deletion of another extension's legacy configuration. |
| Recording and draft ownership | Exercise client recording, transcription, retry, cancellation, duration and size bounds, new-conversation drafts and existing-session drafts. Switching sessions, disabling the feature, replacing the runtime or disconnecting must stop owned work and prevent late text from entering another draft. Transcription never sends automatically. |
| Commands and original tools | Verify native settings from the supported package's commands, including after resource reload. Preserve the original file-transcription tool; do not record from a remote Host's microphone or duplicate the user's separately installed package. |
| Native libraries and shell permissions | Inspect transcribe-cpp platform assets and native dependency build policy in the staged runtime. Run actual transcription with a downloaded model. Verify Desktop microphone permissions and entitlements separately from synthetic MediaStream acceptance; report hardware and platform gaps. Browser recording must not acquire a new FFmpeg requirement; upstream file decoding retains its own requirements. |

## MCP

| Changed surface | Migration and acceptance evidence |
| --- | --- |
| Configuration and precedence | Verify global/shared/project sources against the published public config API, including partial disabled overrides and transport-bound credentials. Preserve comments, unknown options, corrupt files and concurrent edits. Never call an upstream writer that silently replaces a failed read with an empty document. |
| Runtime and tool use | Use a real stdio or HTTP server and a real model turn with an actual approval. Verify lazy discovery, proxy/direct tools, reconnection, resource reload, resume, shutdown and child cleanup. Keep OAuth and connection ownership upstream. |
| Native presentation | Audit the versioned status event before widening supported versions. Confirm cached catalogs are distinct from connections, and session replacement rejects old status. Test supported community-installed precedence and native command adaptation. |
| Published assets | Verify the root extension entry, public config/types exports, MCP SDK closure and optional native keyring assets in fresh standalone staged resources. Record platform and external OAuth gaps. |

Keep the evidence with the update or release task. These rows guide source review and real acceptance; they do not justify architecture tests, DOM snapshots, mocks standing in for SDK interactions, or a new maintenance enforcement framework.
