---
name: interface-acceptance
description: Verify and improve Ling's UI, interaction design, responsiveness and end-to-end user experience in the real application. Use for interface acceptance or retesting, UI/UE/UX audits, slow buttons, loading or switching delays, layout and zoom regressions, keyboard flows, and comprehensive experience optimization. Reproduce with isolated data, measure the actual candidate, fix confirmed causes and repeat the affected journeys.
---

# Interface acceptance

Use this skill to develop and verify Ling’s interface. End-user skin authoring belongs to the built-in skin skill. Read [AGENTS](../../../AGENTS.md), [Design](../../../docs/design.md) and [Development](../../../docs/development.md). Design owns the visual language and control behavior; Development owns launch, isolation, credentials and cleanup. Use the commit, release or Pi maintenance skills only for their requested stages. An audit-only request produces findings without source edits; an optimization request authorizes fixes within its scope.

## Define completion

Record the requested scope before changing code. For a specific regression, trace its complete user journey and neighboring controls sharing its owner. For a comprehensive audit, cover every row in the journey matrix below. Inspect current routes, navigation and feature switches for new surfaces that the matrix may not yet name. State what will count as done: the intended action is discoverable, acknowledges input promptly, produces the right durable result, survives relevant transitions, and exposes recoverable failures without losing user work.

Inspect Git status and the current build. Keep user changes intact. Separate existing work, new findings and verified fixes. A requested baseline commit happens through the commit skill before the audit; it does not authorize a later push or release. Record the commit plus a diff fingerprint when testing uncommitted changes.

## Establish real evidence

Use the existing `pnpm dev-run` workflow with a date-and-purpose run name. Isolate all three homes and keep fixtures, traces and screenshots outside the repository. Stop the owned Desktop instance before rebuilding with `pnpm dev`; editing source or running `build:web` alone does not change its staged runtime. Record candidate, OS, viewport, device scale, application zoom, language, skin, motion setting and whether the run is Desktop or Web.

Use the interface control tool available in the current environment to click, type, navigate, resize and use keyboard shortcuts. Use read-only CDP observations to measure frame timing, long tasks, geometry and state. Follow the tool’s interaction policy. Verify buttons by clicking them through the interface; Host API calls and React atom changes bypass that interaction. Use screenshots to check appearance and actual input to check behavior. Wait for a visible result and refresh the UI state before choosing the next control; do not infer success from the automation call returning.

Create a small representative fixture project through the existing runner. Add a long Markdown document containing headings, links, tables and code, a long file name, and a small editable source file. Keep one recognizable unsent draft, a scrolled document and an expanded result during navigation checks. Use real filesystem and persistence state to verify outcomes. Add an empty state and a failing or delayed state only where they exercise the changed owner. Choose controlled fixture resources for delays; do not break normal configuration or intercept a request into a fabricated success.

Use `--with-auth` when AGENTS requires a real model turn. Give the model a bounded instruction using only fixture files. Exercise actual permission approval and tool results, verify the created file and the displayed outcome, and stop outstanding work. Authentication contents and private launch tokens never belong in evidence. API success alone does not establish approval, streaming, reload, resume or cleanup behavior.

## Journey matrix

For each applicable row, check first open and repeated use. Record the actions taken and their observed outcomes for each screen. Mark an unavailable or intentionally excluded path explicitly and state the reason.

| Journey | Required evidence |
| --- | --- |
| Startup and projects | Isolated cold start, folder selection, correct current project, reopen, visible loading/error recovery and no blank terminal state. |
| Conversation | Compose, model/provider search, thinking and access controls, send, streaming, stop or queue when affected, actual tool approval, result rendering and draft preservation. Switch between two conversations sharing a project and verify their drafts and reading worksets remain independent. |
| Transcript and companions | Expand/collapse thinking, tool/search output and Todo; inspect empty, pending and complete states. Check large content, width changes, history reading position and focus return. Inspect questions and background-task surfaces; exercise execution when changed. |
| Reading workbench | File tree/search, long Markdown, local references, source/preview, real edit and save, diff and review marks, terminal output, project skills/resources and project Pi configuration. Switch tabs, hide/reopen, expand/restore and resize while retaining drafts and reading position. |
| Navigation and search | Sidebar filters, search, new conversation, back/forward and command palette with keyboard; close popovers with Escape and return focus to the originating control. Hidden views must be inert and absent from keyboard traversal. |
| Schedules | Empty/list/detail, create, edit, pause, filtering, validation and cancellation. Inspect destructive confirmation without deleting user data. Keep test tasks paused unless executing them is part of the authorized acceptance. |
| General and appearance | Theme, skin/artwork, motion, zoom, language, update state and terminal preferences. Verify persistence where changed and preserve active drafts/editors. System permissions and updater installation need their own authorized scope. |
| Pi and resource settings | Pi options, model catalog, MCP form/scope, feature/plugin switches, skills and permission configuration. Confirm immediate acknowledgement, pending state, duplicate-click handling, final saved/reloaded state and visible failure recovery for affected mutations. |
| Usage and diagnostics | Empty and populated usage, ranges and provider quota states, logs/filtering, long values, partial failures and refresh feedback. Do not equate unavailable data with zero. |

Test the highest-risk journeys across these dimensions and record the combinations exercised:

- Mouse and keyboard: Tab/Shift+Tab, arrow keys, Enter/Space and Escape; focus visibility, ordering, accessible names, validation association, focus entry and return. Ling shows keyboard focus through surface and text changes. Check selected controls as well as unselected ones. An accessibility tree is not a VoiceOver test.
- Layout: normal and narrow windows, the Design zoom range, supported responsive breakpoints, long localized labels, multiline errors and scrollable modal bodies. Keep primary and cancel actions reachable. Test resizing in both directions across a breakpoint, including repeated changes.
- Appearance: light, dark and one available artwork skin; hover, pressed, selected, pending and disabled states; system reduced motion and skin motion settings. Measure computed/composited colors before claiming contrast failure. Preserve existing semantic tokens and component ownership.
- Continuity: first open, repeated open, a background operation, navigation away/back, resource reload or process restart when relevant. Check the exact unsent text, current project/session, selected tab, file contents and reading position after each transition. Verify each retained value against the fixture.

## Measure perceived and actual latency

Separate input acknowledgement, completion and background work. For a button that saves and reloads resources, record the click-to-pending/selected frame and the final save/reload result independently. Capture before/after measurements on the same fixture, viewport and candidate settings, with cold and repeated interactions kept separate. Gather several samples; retain counts and ranges and identify any outlier. Label a custom click-to-frame measurement with its actual timing definition. INP requires its own measurement method; tool-call wall time includes automation overhead.

Aim for visible local acknowledgement within 100 ms. Investigate main-thread tasks over 50 ms and frames that exceed the display's frame budget on the affected journey. These thresholds identify work to investigate. Acceptance also depends on the journey’s behavior. Trace blocking work to its owner before editing: synchronous parsing, oversized rendering batches, broad state subscriptions, repeated remounts, unbounded history or layout measurement. Check that the measuring tool itself did not block the clipboard, pause the process or distort the run.

Fix the smallest confirmed cause. Bound expensive work, keep state with its owning feature and allow feedback to respond to further input. Do not add arbitrary timers, hide errors, disable useful controls for the whole page, or display a completed state before durable success. Preserve serialization, rollback and stale-result fencing. Add motion only when it explains a transition; use the shared motion system and verify reduced motion. Check reading geometry after any progressive rendering or virtualization change.

## Review and iterate

Review accessibility, grouping/layout, product wording, typography, colors and control polish across the inspected surfaces. Use relevant available design skills for their domains without overriding Ling's documented behavior. Consolidate repeated symptoms under their shared owner; rank loss of work, inaccessible actions, incorrect outcomes and blocking delays before decoration. Cite runtime evidence and the source location for each actionable finding. Label a finding as a hypothesis until its failure is reproduced or traced. Source edits require a confirmed cause and authorization for that scope.

For each fix, record the user-visible invariant, root cause, smallest change and repeatable acceptance steps. Use the existing behavior owner's tests for meaningful async, persistence or interpretation invariants. Do not add DOM snapshots, class-name tests, architecture tests or per-screen automation scripts. Temporary instrumentation stays in the isolated run. A permanent helper needs a recurring capability that existing tooling does not provide, an explicit owner and cleanup, and a demonstrated use; a one-off audit keeps its helpers in the isolated run.

Rebuild the actual candidate and repeat the failed journey plus affected neighboring journeys. Run scoped checks or `pnpm verify` according to AGENTS and the breadth of the change. Reopen saved state from disk when persistence matters. Replay the interaction in a build containing the final source changes, alongside the selected tests. Keep iterating until confirmed in-scope regressions are fixed or a concrete external limitation is recorded.

## Deliver and clean up

Save a compact acceptance record in the run's evidence directory with these fields:

| Field | Content |
| --- | --- |
| Candidate and environment | Commit/diff fingerprint, build command, run identity, OS, dimensions, zoom, language, skin and motion. |
| Coverage | Each journey and cross-cutting dimension, exact actions, resulting state, evidence path and passed/failed/not verified. |
| Findings and decisions | Severity, user impact, reproduced state, owning source, chosen change and trade-off. Include unresolved limitations. |
| Measurements | Comparable before/after samples, units, timing definition, sample count and instrument limitations. |
| Verification | Source checks, actual rebuilt runtime, persisted outcomes and explicit gaps. |
| Publication state | Changes, local commits, pushed refs and release are separate states. |

Stop the owned run, verify its Host/Pi/plugin children exited, check the runner removed copied authentication, and restore temporary viewport/media overrides. Preserve evidence needed for review; do not touch normal Ling or Pi data. Report the important outcomes and remaining gaps in the user's language, linking the new skill or evidence when useful. Report exactly which journeys, configurations and platforms were verified.
