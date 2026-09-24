# Interface design and component ownership

Ling's application uses one control system. Visual fixes belong to the owning component. [Architecture](architecture.md) describes runtime and state ownership.

## Layout and behavior

The left navigation, conversation, reading area and contextual sidebar have separate owners. Files open beside the conversation. Closing a reading tab preserves its source session and unsent Composer. Collapsing the right panel retains its tabs for restoration. The terminal opens below the conversation, independently of the reading area. Expanding the reading area reuses the same editor and draft owner. Each tab group owns its active and preview state. A single click previews a session; double-click keeps its tab open. Tab actions belong in the context menu rather than duplicate overflow controls.

The session tab row belongs to the conversation's visual surface. One backdrop extends through the row to the top of the window, without a separate titlebar fill or horizontal seam. Reading and contextual panes retain their own surface and foreground tokens over that backdrop. Keep the window drag region and controls in their existing safe row.

The scheduled-tasks page uses the same 44px window titlebar and sidebar controls as the workspace. Navigate through the sidebar; do not add a separate return-to-workspace button above the page.

The sidebar's today-usage summary refreshes on session changes while visible and checks external Pi activity every five minutes. Hidden windows defer scans until visible. Relative session timestamps have their own clock and do not keep the usage scanner active.

The current turn's work stays expanded as intermediate assistant replies and tool calls alternate. Starting a reply must not temporarily collapse earlier work and reopen it when a tool starts. Manual disclosure choices still apply; settled turns retain their process fold.

Assistant prose keeps its mounted content through tool-call transitions and settlement. When a turn finishes, its work folds away while the terminal reply remains in place and gains its message actions. Background title generation must not reopen completed work. Transcript virtualization owns visibility and geometry, so Markdown must not substitute an estimated offscreen height. Code stays readable at its actual height until syntax highlighting has rendered. New text uses a short opacity fade; streaming does not animate container height or replay settled paragraphs.

Quickstart and conversations share the Composer's surface, controls and draft projection. Selecting a folder or changing language must preserve editable content, selection and undo history. Mode changes save on selection; confirmation belongs to an actual approval request. The permission system adapter owns policy selection, not another Composer or a second approval UI.

Files and media appear in one attachment area above the Composer text. Adding an existing file reference reuses the same attachment. Text editing and undo do not remove attachments. Images show thumbnails; supported audio and video open with playback controls. A failed preview retains its file card and download action. Attachment previews return keyboard focus to their trigger on close. When the home Composer exceeds the available height, the page scrolls so its editor and send controls remain reachable.

Composer completions open above the full input width and remain within the available viewport. Session commands, extension commands, skills and prompt templates have separate headings; project references show file names and paths. Names, descriptions and argument hints remain readable with natural wrapping. Search uses both invocation names and descriptions, including localized text. Quickstart offers the selected project's skills and files before a session exists. Arrow keys select, bare Enter or Tab accepts, and Escape dismisses without changing the draft; subsequent editing reopens suggestions. Focus remains in the editor with an active-descendant link to the listbox. Failed lookups show their error and offer pointer or Enter retry; changing the query or project invalidates the old selectable results.

Web folder selection browses the computer running Ling: users can enter a path, visit the home or parent directory, show hidden folders, and select the current folder. Failed reads stay visible, unavailable links remain marked, and bounded listings disclose omitted entries. A cancelled or superseded browse cannot update a later selection. Desktop uses the system folder picker; browser-local file handles cannot identify a remote Host project path.

Interface zoom must preserve anchored menus, scrolling and keyboard selection in both products. Web uses CSS zoom; Desktop uses native page zoom. The Floating UI Core and DOM ES module entries carry the [upstream CSS zoom correction](https://github.com/floating-ui/floating-ui/pull/3492), which is absent from the published 1.8.0 packages. Remove these patches when the dependency includes that correction, after checking menu placement and selection at 80%, 100% and 150% in Web and Desktop.

Session analysis and provider quotas use compact inspectors with 44px headers and divided disclosure rows. Keep account limits, balances and model/tool breakdowns in lists; charts and provider glyphs add context without nested cards. Session analysis keeps its height stable while sections expand. Details mount on first expansion, preserve their selection until the dialog closes, and use brief opacity/transform motion. Missing or failed quota data remains explicit.

The default interface is monochrome with sparse accent. Settings use divided rows, modest headings and short descriptions. A narrow viewport stacks field labels above controls. Selecting any settings entry closes the navigation sheet, including feature entries and the already active page. Workbench tools use compact panels; full settings-page padding must not consume a narrow sidebar. Product screens show configuration and failures, not build hashes and implementation paths unless those paths are the object being edited.

Long settings option groups use the shared stacked field layout. Pi default tools place their label and description above an equal-width grid that adapts to the available content width, so the sidebar and interface zoom cannot squeeze the description into a narrow column.

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
| Anchored selection panels | `components/ui/picker-panel.tsx`; `features/models/model-picker.tsx` owns model and provider navigation |
| Popup surfaces, motion and highlights | `components/ui/menu-styles.ts`, `menu.css` |
| Navigation entries | `components/ui/navigation-item.tsx` |
| Settings structure | `components/ui/settings-page.tsx`, `settings-list.tsx` |
| Expandable inspector rows | `components/ui/disclosure-row.tsx` |
| Contextual tool pages | `components/ui/panel-page.tsx` |
| Feedback and failures | `components/ui/feedback.tsx` |
| Dialogs, pending questions and approvals | `components/ui/dialog.tsx`, `interaction-card.tsx`; chat and Host feature response owners |

The paths above are relative to `apps/web/src/`. Import their owning modules directly. Do not create pass-through component directories or copy their CSS into a feature.

`features/companions/use-feature-snapshot.ts` is the shared load/refresh/act hook for Host-owned feature state; `lib/app-navigation.ts` exposes cross-screen navigation; `components/workbench/feature-navigation.ts` opens session-owned feature pages without importing the workspace composition root. Feature pages compose the shared controls with Tailwind layout classes; they must not redefine an ordinary button's hover colors, a menu's geometry, or a form's typography.

Native file inputs, radio inputs for artwork previews, editable tree labels, drag handles, editor content and virtualized transcript rows retain their specialized feature owners. They are not competing general-purpose UI kits. New ordinary actions should use shared controls; a specialized interaction must retain an accessible name, keyboard operation and visible focus.

## Menus and focus

Selects, dropdown menus and context menus share a tinted, blurred surface, compact 28px rows and inset corners. The highlighted item paints its own background immediately; pointer movement, keyboard navigation and scrolling keep the same geometry from the first opening. Selection uses the skin's authored choice pair or its accent with a contrasting foreground. Separators remain inset from the outer edge.

Do not draw focus rings anywhere in Ling, including existing controls, custom feature interactions, Markdown, code editors and Pi UI adaptations. Focus must not add an outline, border, inset ring or shadow. Preserve native focus, keyboard navigation, focus restoration, text carets and selection. Use an appropriate background or text treatment to identify a keyboard target. Validation borders and persistent surface hairlines are independent of focus.

Escape closes without changing the selection and restores focus to the trigger, including triggers in Pi extension dialogs. Menus retain Radix's focus collection and typeahead; do not recreate either in feature event handlers. Full labels must remain available for truncated project names. Menu actions use the desktop arrow cursor; ordinary controls inherit Ling's cursor and focus treatment.

## Model selection

Model selection opens in an anchored non-modal popover, above its Composer trigger or below its settings trigger. It has no backdrop and never moves the editor, transcript or neighboring settings fields. Conversation, quickstart, Pi defaults, per-model compaction settings and reference-model selection share one picker. Narrow Composers keep the model trigger directly visible. Opening or closing the picker must preserve the editor instance, draft, attachments and undo history; changing its owning project or conversation closes it.

The selection surface is 440px wide, constrained to the available viewport or containing dialog, and normally 304px tall. When the available viewport height is smaller, only the list area contracts so the search and footer remain reachable. It flips and shifts near an edge without changing surrounding layout. Search and footer stay fixed while provider and model lists scroll independently; empty results and provider navigation keep the same height. At widths below 376px, provider selection occupies the same list area with a back action. Wider panels show a 108px provider rail. Provider filtering uses the actual configured provider, including when a model ID names another provider. The provider rail follows model search results while retaining All providers and the selected provider. Its search action opens the provider page in the same surface; provider search matches provider names and IDs independently of the model query. Each page retains its own query when navigating between them. Browse across all providers by default, or narrow to one without losing the model query. Full model identities remain available on hover.

Search follows Pi TUI's whitespace/slash tokenization, ordered fuzzy matching, letter/number token fallback and relevance ranking. All tokens must match. Search also includes provider display names. Current and known default models lead an unfiltered list; a default prefix finds the supplied default model. A changed query highlights its best result, and matching text is emphasized without changing the label. The search field’s clear action clears only the current page’s query and keeps the picker open. Tab reaches the provider rail as one stop; arrows or Home/End move within it and Enter confirms the provider before returning to model search. Arrow keys move through search results and Enter selects; IME confirmation must not select a model. Escape closes the provider page first, then the picker, restoring trigger focus; selection returns to the Composer editor when applicable. Clicks or focus outside close the picker. Keyboard targets use quiet backgrounds with no focus rings.

## Questions and approvals

Permission prompts and asynchronous questions align with the Composer's full width; overlay positioning adds no extra horizontal inset. Preserve complete titles, questions and option descriptions with natural wrapping, including long paths and explicit line breaks. The card body owns vertical scrolling; individual descriptions and approval details do not add height caps or nested scroll areas. Keep actions visible while reading long content.

Host questions and Pi approvals share InteractionCard and InteractionChoice. Keep their distinct response owners and cancellation semantics. Single click selects; a separate confirmation or double click confirms. Multi-question forms advance one question at a time, move keyboard focus into the next question and submit only complete answers. Keep the instruction alongside footer actions. A multi-choice double click must not toggle its item off on the second click. Full-width options use native radio or checkbox rows with leading indicators, quiet selected surfaces and wrapped descriptions; compact filter choices retain ChoiceButton. Question cards identify single/multiple selection, keep supplemental text independent of selections, and offer clearing selections for a text-only answer. Text fields have visible labels and bounded content-based height. Pi select/confirm remain single-choice and retain their original result types.

Show only the earliest pending Host question above the Composer. Other requests remain reachable from the global pending entry; finishing the visible request advances to the next. Multiple requests must not stack until they displace the conversation.

A new input card pulses its edge twice, then keeps a static highlight. While it is visible, pause the conversation's decorative progress animations so motion behind the translucent card does not keep repainting its backdrop. Elapsed time and execution state remain live; normal motion resumes when the card closes.

Question body and question titles use Ling Markdown. Literal operation arguments remain code in approval cards. Selected descriptions inherit the selected foreground rather than the unselected muted token. Answers appear as user replies, using Pi steering while busy; show the queued answer immediately while a tool is still running. Its durable request identity survives history reload and retry.

## Built-in feature switches

Settings → Plugins presents the six Ling features as shared toggle rows before Pi package management. These switches control runtime resources, not just visual elements. Keep the saved choice visible during reload and report deferred or failed reloads. A disabled feature retains readable history and cleanup actions, with an inline notice linking to Plugins; prevent new work at both the UI and Host. Permission controls show that the master switch is off rather than claiming a saved approval mode is active. Scheduled tasks show suspended triggers while the feature is off.

Voice input is off by default and can be enabled in Plugins. The Composer has one voice button: start recording, stop and transcribe, cancel an operation, or retry retained audio. Its context menu contains settings and discard; Plugins also provides a settings entry. While focus is inside the visible Composer, Mod+Alt+V invokes the button, Mod+Shift+Alt+V opens settings, and Escape cancels recording or transcription, including retained audio awaiting a retry. These shortcuts must not capture input from dialogs, menus, terminals or other editors.

First use opens the shared settings dialog to select a local model; show its download size and require an explicit download action. Order models by support for the interface language, then downloaded status and size, and show their actual supported languages. Preserve compatible language choices when changing models, distinguish Mandarin from Cantonese, and show Chinese output conversion only when applicable. Localize microphone failures with a recovery action; retain technical details for other failures. Recording exposes elapsed time and level feedback beside the single button, with a two-minute limit. Transcription adds text to the existing draft for review and never sends it. Preserve audio for an explicit retry after transcription fails, and keep recognized text available if the draft is full. Switching away from the session, hiding the page or disabling Voice stops recording; late results must not enter another draft. The settings dialog and upstream `/voice-settings` command use the same controls.

## Skins, typography and motion

Use semantic action, choice, surface, text and radius tokens. Palette values and artwork belong to the skin resolver. Controls do not choose a light or dark palette. Host feature pages and Pi UI adaptations inherit the active tokens and shared styles; they must not install a focus ring or a different cursor rule. Portalled menus use the same active document tokens. Shared controls use the same material on macOS, Windows and Web; native window chrome remains Desktop-owned.

Floating menus start with an 86% tint and a static 24px blur. Dialogs and hints retain at least 94% tint to quiet content behind form fields. The resolver strengthens these materials and their secondary text when the authored palette needs more contrast; solid skins and reduced transparency remain opaque. Surface depth follows the skin's elevation setting. Buttons and fields share compact sizing, quiet permanent edges and restrained press feedback. Nested corners account for their container padding.

Reference resolved shadows with `shadow-(--shadow-floating)` and the corresponding control, input, choice or reading token. Named Tailwind shadow utilities can inline the first-paint value at build time and ignore later skin overrides.

Small desktop UI uses the existing `text-ui`, `text-sm` and `text-xs` scale. Main settings headings use `text-xl`; tool panel headings use `text-base`. Body and wrapped descriptions need comfortable line height. Preserve space for Chinese, English, Japanese and Korean. Changes to language refresh labels without replacing editors or drafts.

Motion must honor both the operating system's reduced-motion preference and the skin's motion setting, including controls already open and Pi UI adaptations. Animate transform and opacity, keep frequently used controls brief, and interrupt previous animations when input changes. Menu highlights are immediate and never affect layout.

## Acceptance

Use [AGENTS.md](../AGENTS.md) for test selection and [Development](development.md) for isolated runs and evidence capture. The following matrix defines the interface states to inspect in the rebuilt application.

For shared controls, inspect first opening, close/reopen, pointer movement, keyboard navigation, Escape and focus return. Check representative application, Host feature and Pi extension call sites, long labels and scrollable lists. Verify light, dark and artwork skins, reduced motion, supported languages, narrow widths and zoom. Record the surfaces actually exercised and any unverified environment; source inspection alone does not establish visual acceptance.
