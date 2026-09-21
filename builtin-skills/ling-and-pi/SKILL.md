---
name: ling-and-pi
description: "Configure and troubleshoot Pi in Ling: global versus project settings, project trust, instruction files, resource reload, and shared data directories. Use when a setting or prompt did not take effect, Ling and the Pi CLI behave differently, or the user needs to locate the effective configuration."
---

# Configuring Pi in Ling

Help the user identify the effective configuration, make the requested change, and verify its effect in Ling. Use the `ling_plugins` tool or Settings → Plugins for Pi packages/extensions, [manage-skills](../manage-skills/SKILL.md) for standalone skills, and [skin-studio](../skin-studio/SKILL.md) for Ling appearance packages.

Ling embeds Pi and shares its configured agent directory with the CLI. Pi's installed documentation owns setting names, prompt semantics, and file formats; read the relevant documentation and actual files instead of inventing configuration keys. This skill covers the differences that matter when using Pi through Ling.

## Locate the effective configuration

Resolve the current project and the actual Pi agent directory before editing. `<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` can override it. In a browser connection, these are paths on the machine running Ling's Host.

| Concern | Location or Ling behavior |
| --- | --- |
| Global Pi settings | `<agent-dir>/settings.json`; Ling's Pi Settings controls edit this scope |
| Project Pi settings | `<project>/.pi/settings.json`; trusted project values override global values, including nested settings |
| Project Pi Config panel | A read-only view of that project's settings; edit the file with normal file tools |
| Global instructions | `<agent-dir>/AGENTS.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md`; Ling provides editors for these files |
| Credentials and models | Pi's `auth.json` and `models.json` under `<agent-dir>`; use Ling's credential/model controls when available and never print secrets |
| Session history | Pi files under `<agent-dir>/sessions`; locate the actual session rather than reconstructing its filename or editing a live log |
| Ling app state | Separate app data; `LING_USER_DATA_DIR` moves it without moving Pi data or `~/.ling/skins` |
| Ling feature state | Todo review, access mode, questions, background tasks and schedules keep their data under `~/.ling` (`LING_HOME`); the permission system's rule files stay in Pi's own locations |

A different CLI executable or agent directory can explain different behavior. Upgrading the Pi CLI does not upgrade Ling's bundled Pi SDK. The workspace terminal is separate from agent shell tools; their output is not mirrored.

## Change or diagnose a setting

1. Inspect the requested setting or instruction and both relevant scopes. Distinguish a missing file, an untrusted project, a parse failure, and a value overridden elsewhere.
2. Check project trust before expecting protected project settings or resources to load. Use Ling's trust flow; do not bypass a declined decision by changing trust files or moving the same code into global scope. Context instructions such as project or ancestor `AGENTS.md` can still load without trust.
3. Change only the intended scope and preserve unrelated settings. Use available Ling controls or ordinary file tools; a skill does not grant access to the interface. For changes to global prompt files, inspect possible trusted project `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md` overrides as well.
4. After manual Pi configuration or resource edits, use Settings → Skills → Reload to reconcile open projects and sessions. Changing the access mode in Settings → Permission configuration or the composer reloads the affected projects the same way. Inspect pending and failed reloads. Saving a file or opening a new conversation does not prove that existing sessions have refreshed.
5. Verify the effective value or behavior in the affected project. Defaults and a session's current model/thinking selection are different states; changing a default need not change an existing conversation. Route missing skills or extension errors to their owning management skill.

Report the file or control changed, its scope, and what confirms the result. If interface control is unavailable, complete the authorized file work and state the specific reload or live check still needed. Keep failures visible and redact credential values from diagnostic output.
