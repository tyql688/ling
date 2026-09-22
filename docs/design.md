# Interface design and component ownership

Ling's application uses one control system. Visual fixes belong to the owning component. [Architecture](architecture.md) describes runtime and state ownership.

## Layout and behavior

The left navigation, conversation, reading area and contextual sidebar have separate owners. Files open beside the conversation. Closing a reading tab preserves its source session and unsent Composer. Collapsing the right panel retains its tabs for restoration. The terminal opens below the conversation, independently of the reading area. Expanding the reading area reuses the same editor and draft owner. Each tab group owns its active and preview state. A single click previews a session; double-click keeps its tab open. Tab actions belong in the context menu rather than duplicate overflow controls.

The session tab row belongs to the conversation's visual surface. One backdrop extends through the row to the top of the window, without a separate titlebar fill or horizontal seam. Reading and contextual panes retain their own surface and foreground tokens over that backdrop. Keep the window drag region and controls in their existing safe row.

The sidebar's today-usage summary refreshes on session changes while visible and checks external Pi activity every five minutes. Hidden windows defer scans until visible. Relative session timestamps have their own clock and do not keep the usage scanner active.

Quickstart and conversations share the Composer's surface, controls and draft projection. Selecting a folder or changing language must preserve editable content, selection and undo history. Mode changes save on selection; confirmation belongs to an actual approval request. The permission system adapter owns policy selection, not another Composer or a second approval UI.

Files and media appear in one attachment area above the Composer text. Adding an existing file reference reuses the same attachment. Text editing and undo do not remove attachments. Images show thumbnails; supported audio and video open with playback controls. A failed preview retains its file card and download action. Attachment previews return keyboard focus to their trigger on close. When the home Composer exceeds the available height, the page scrolls so its editor and send controls remain reachable.

Composer completions open above the full input width and remain within the available viewport. Session commands, extension commands, skills and prompt templates have separate headings; project references show file names and paths. Names, descriptions and argument hints remain readable with natural wrapping. Search uses both invocation names and descriptions, including localized text. Quickstart offers the selected project's skills and files before a session exists. Arrow keys select, bare Enter or Tab accepts, and Escape dismisses without changing the draft; subsequent editing reopens suggestions. Focus remains in the editor with an active-descendant link to the listbox. Failed lookups show their error and offer pointer or Enter retry; changing the query or project invalidates the old selectable results.

Web folder selection browses the computer running Ling: users can enter a path, visit the home or parent directory, show hidden folders, and select the current folder. Failed reads stay visible, unavailable links remain marked, and bounded listings disclose omitted entries. A cancelled or superseded browse cannot update a later selection. Desktop uses the system folder picker; browser-local file handles cannot identify a remote Host project path.

Interface zoom must preserve anchored menus, scrolling and keyboard selection in both products. Web uses CSS zoom; Desktop uses native page zoom. The Floating UI Core and DOM ES module entries carry the [upstream CSS zoom correction](https://github.com/floating-ui/floating-ui/pull/3492), which is absent from the published 1.8.0 packages. Remove these patches when the dependency includes that correction, after checking menu placement and selection at 80%, 100% and 150% in Web and Desktop.

The default interface is monochrome with sparse accent. Settings use divided rows, modest headings and short descriptions. A narrow viewport stacks field labels above controls. Selecting any settings entry closes the navigation sheet, including feature entries and the already active page. Workbench tools use compact panels; full settings-page padding must not consume a narrow sidebar. Product screens show configuration and failures, not build hashes and implementation paths unless those paths are the object being edited.

## Component map

| Responsibility | Owner |
| --- | --- |
| Page actions and icon actions | `components/ui/button.tsx`, `icon-button.tsx`, `tooltip-icon-button.tsx` |
| Selected choices | `components/ui/choice-button.tsx`, `multi-select-group.tsx`; `choice-row.tsx` for full-width native radio/checkbox rows |
| Segmented filters | `components/ui/segmented.tsx` |
| Fields and labels | `components/ui/input.tsx`, `textarea.tsx`, `form-field.tsx` |
| Option selection | `components/ui/select.tsx` |
| Action menus | `components/ui/dropdown-menu.tsx`, `context-menu.tsx` |
| Composer completion lists | `components/ui/completion-panel.tsx`; `hooks/use-completion-popover.ts` owns input focus and keyboard selection |
| Popup motion and highlight geometry | `components/ui/menu-styles.ts`, `menu-motion.ts`, `menu.css` |
| Navigation entries | `components/ui/navigation-item.tsx` |
| Settings structure | `components/ui/settings-page.tsx`, `settings-list.tsx` |
| Contextual tool pages | `components/ui/panel-page.tsx` |
| Feedback and failures | `components/ui/feedback.tsx` |
| Dialogs, pending questions and approvals | `components/ui/dialog.tsx`, `interaction-card.tsx`; chat and Host feature response owners |

The paths above are relative to `apps/web/src/`. Import their owning modules directly. Do not create pass-through component directories or copy their CSS into a feature.

`features/companions/use-feature-snapshot.ts` is the shared load/refresh/act hook for Host-owned feature state; `lib/app-navigation.ts` exposes cross-screen navigation; `components/workbench/feature-navigation.ts` opens session-owned feature pages without importing the workspace composition root. Feature pages compose the shared controls with Tailwind layout classes; they must not redefine an ordinary button's hover colors, a menu's geometry, or a form's typography.

Native file inputs, radio inputs for artwork previews, editable tree labels, drag handles, editor content and virtualized transcript rows retain their specialized feature owners. They are not competing general-purpose UI kits. New ordinary actions should use shared controls; a specialized interaction must retain an accessible name, keyboard operation and visible focus.

## Menus and focus

Selects, dropdown menus and context menus share their surface, item spacing, disabled treatment and moving highlight. A popup's opening scale must never enter local highlight coordinates. Measure layout offsets and layout sizes, including nested offsets; observe the open surface and focused item for size changes. Pointer movement and arrow keys must produce the same geometry from the first opening. Scrolling moves the highlight with the items.

Escape closes without changing the selection and restores focus to the trigger, including triggers in Pi extension dialogs. Menus retain Radix's focus collection and typeahead; do not recreate either in feature event handlers. Full labels must remain available for truncated project names. Menu actions use the desktop arrow cursor; ordinary controls inherit Ling's cursor and focus treatment.

## Questions and approvals

Permission prompts and asynchronous questions align with the Composer's full width; overlay positioning adds no extra horizontal inset. Preserve complete titles, questions and option descriptions with natural wrapping, including long paths and explicit line breaks. The card body owns vertical scrolling; individual descriptions and approval details do not add height caps or nested scroll areas. Keep actions visible while reading long content.

Host questions and Pi approvals share InteractionCard and InteractionChoice. Keep their distinct response owners and cancellation semantics. Single click selects; a separate confirmation or double click confirms. Multi-question forms advance one question at a time, move keyboard focus into the next question and submit only complete answers. Keep the instruction alongside footer actions. A multi-choice double click must not toggle its item off on the second click. Full-width options use native radio or checkbox rows with leading indicators, quiet selected surfaces and wrapped descriptions; compact filter choices retain ChoiceButton. Question cards identify single/multiple selection, keep supplemental text independent of selections, and offer clearing selections for a text-only answer. Text fields have visible labels and bounded content-based height. Pi select/confirm remain single-choice and retain their original result types.

Show only the earliest pending Host question above the Composer. Other requests remain reachable from the global pending entry; finishing the visible request advances to the next. Multiple requests must not stack until they displace the conversation.

A new input card pulses its edge twice, then keeps a static highlight. While it is visible, pause the conversation's decorative progress animations so motion behind the translucent card does not keep repainting its backdrop. Elapsed time and execution state remain live; normal motion resumes when the card closes.

Question body and question titles use Ling Markdown. Literal operation arguments remain code in approval cards. Selected descriptions inherit the selected foreground rather than the unselected muted token. Answers appear as user replies, using Pi steering while busy; show the queued answer immediately while a tool is still running. Its durable request identity survives history reload and retry.

## Built-in feature switches

Settings → Plugins presents the five Ling features as shared toggle rows before Pi package management. These switches control runtime resources, not just visual elements. Keep the saved choice visible during reload and report deferred or failed reloads. A disabled feature retains readable history and cleanup actions, with an inline notice linking to Plugins; prevent new work at both the UI and Host. Permission controls show that the master switch is off rather than claiming a saved approval mode is active. Scheduled tasks show suspended triggers while the feature is off.

## Skins, typography and motion

Use semantic action, choice, surface, text and radius tokens. Palette values and artwork belong to the skin resolver. Controls do not choose a light or dark palette. Host feature pages and Pi UI adaptations inherit the active tokens and shared styles; they must not install a different base focus outline or cursor rule. Portalled menus use the same active document tokens.

Small desktop UI uses the existing `text-ui`, `text-sm` and `text-xs` scale. Main settings headings use `text-xl`; tool panel headings use `text-base`. Body and wrapped descriptions need comfortable line height. Preserve space for Chinese, English, Japanese and Korean. Changes to language refresh labels without replacing editors or drafts.

Motion must honor both the operating system's reduced-motion preference and the skin's motion setting, including controls already open and Pi UI adaptations. Animate transform and opacity, keep frequently used controls brief, and interrupt previous animations when input changes. A static focus background remains when animated highlighting is disabled. A menu highlight must not affect layout.

## Acceptance

Use [AGENTS.md](../AGENTS.md) for test selection and [Development](development.md) for isolated runs and evidence capture. The following matrix defines the interface states to inspect in the rebuilt application.

For shared controls, inspect first opening, close/reopen, pointer movement, keyboard navigation, Escape and focus return. Check representative application, Host feature and Pi extension call sites, long labels and scrollable lists. Verify light, dark and artwork skins, reduced motion, supported languages, narrow widths and zoom. Record the surfaces actually exercised and any unverified environment; source inspection alone does not establish visual acceptance.
