---
name: ling-and-pi
description: "Configure and troubleshoot Pi and MCP services in Ling: add or edit MCP servers, global versus project scope, feature and service switches, project trust, instructions, and resource reload. Use when configuring MCP from a conversation, a setting did not take effect, or Ling and the Pi CLI behave differently."
---

# Configuring Pi in Ling

Help the user identify the effective configuration, make the requested change, and verify its effect in Ling. Use the `ling_plugins` tool or Settings → Plugins for Pi packages/extensions, [manage-skills](../manage-skills/SKILL.md) for standalone skills, and [skin-studio](../skin-studio/SKILL.md) for Ling appearance packages.

Ling embeds Pi and shares its configured agent directory with the CLI. Read Pi's installed documentation and configuration files for supported setting names, prompt behavior and file formats. This skill covers the differences that matter when using Pi through Ling.

## Configure MCP from a conversation

Read [references/mcp.md](references/mcp.md) when adding, changing, removing, enabling or troubleshooting MCP services. Prefer the `ling_mcp` management tool when available. It stays available while built-in MCP execution is off; configuration edits preserve that switch. Read the current feature state and target file revision before changes, use the user's intended scope, and report saved configuration, pending reloads and live connection checks separately. Pi resolves MCP tool availability from its extension and service settings. The `ling-and-pi` switch controls whether this guidance is loaded.

## Locate the effective configuration

Resolve the current project and the actual Pi agent directory before editing. `<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` can override it. In a browser connection, these are paths on the machine running Ling's Host.

| Concern | Location or Ling behavior |
| --- | --- |
| Global Pi settings | `<agent-dir>/settings.json`; Pi Settings → Global edits this scope |
| Project Pi settings | `<project>/.pi/settings.json`; trusted project values override global values, including nested settings |
| Project Pi Config panel | The same scoped configuration editor as Pi Settings; inspect configured, inherited and effective values, edit trusted projects or reset overrides |
| MCP configuration | `ling_mcp` or Settings → MCP services; see the MCP reference for official global/project configuration |
| Global instructions | `<agent-dir>/AGENTS.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md`; Ling provides editors for these files |
| Session Details | `/session` or the composer button: active tools and tool filters, branch navigation and labels, system prompt, runtime extension flags, context/cache status and HTML/JSONL import/export |
| Credentials and models | Pi's `auth.json` and `models.json` under `<agent-dir>`; use Ling's credential/model controls when available and never print secrets |
| Session history | Pi files under `<agent-dir>/sessions`; locate the actual session rather than reconstructing its filename or editing a live log |
| Ling app state | Separate app data; `LING_USER_DATA_DIR` moves it without moving Pi data or `~/.ling/skins` |
| Ling feature state | Built-in switches and feature data live under `~/.ling` (`LING_HOME`); change switches through Ling controls or their management tools. The permission system's rule files stay in Pi's own locations |

Check the CLI version and agent directory when behavior differs. Ling ships its own Pi SDK version with the application. Workspace terminals and agent shell tools run separately and display output in their respective views.

## Configure Azure and Codemode

Azure uses the provider ID `azure`. For a saved provider ID of `azure-openai-responses`, update the provider keys in `auth.json` and `models.json`, and references in `settings.json` (`defaultProvider`, `enabledModels`, and `modelThinkingLevels`). Its models can use the `azure-openai-responses` or `openai-completions` API protocol; preserve that protocol when updating a provider ID. Configure the endpoint with `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`; `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` maps catalog model IDs to deployment names. Use the installed Pi documentation for the accepted credential and model fields and preserve unrelated entries. After opening an existing Azure session, verify its selected provider and model before sending a message.

Enable `codemode` for the current conversation in Session Details → Tools. Pi's `defaultTools` setting controls the starting tool set for new sessions; preserve the other tools when changing it. Codemode's `image()` shows an image and includes its temporary file path in the result. Ling keeps the image in session history for preview and download. Use a file tool with the required permission to copy the temporary file into the project when the user needs a working file; a temporary path is not permanent storage.

For an existing image, Codemode can call `image(await tools.read({ path: "image.png" }))`. The read tool returns image content, and its usual permission checks apply to the nested call.

## Choose tools for one conversation

Open Session Details → Tools → Tool filters. Choose Pi defaults, matching tools, or disable all tools. Enter names or `*` patterns separated by commas or new lines. Exclusions take priority. A nonempty allowlist without a `mcp__` entry keeps MCP tools registered. Their exposure still applies: Codemode can call `codemode` and `deferred` tools, while `direct` tools must also match the allowlist to activate. Add patterns such as `mcp__docs__*` to filter MCP tools as well. The built-in MCP switch applies to this conversation. User-installed MCP replacements follow their own configuration.

Apply while the conversation is idle. Ling reloads extensions and resets the active tool selection. Check the resulting list before the next turn. The filter is saved with conversation history and survives resource reload and reopening. Pi persists a new session when its first conversation message arrives. Navigating within a session keeps that file's current filter; a fork inherits filter entries on the copied history path. Tool filters control availability, and permission rules determine approval for each callable tool.

## Change or diagnose a setting

1. Inspect the requested setting or instruction and both relevant scopes. Distinguish a missing file, an untrusted project, a parse failure, and a value overridden elsewhere.
2. Check project trust before expecting protected project settings or resources to load. Use Ling's trust flow and honor declined decisions. Loading that code from another scope also requires authorization. Context instructions such as project or ancestor `AGENTS.md` can still load without trust.
3. Change only the intended scope and preserve unrelated settings. Use the Ling controls or file tools available in the session. For changes to global prompt files, inspect possible trusted project `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md` overrides as well.
4. After manual Pi configuration or resource edits, use Settings → Skills → Reload to reconcile open projects and sessions. Changing the access mode in Settings → Permission configuration or the composer reloads the affected projects the same way. Inspect pending and failed reloads. Verify resource application in the existing sessions.
5. Verify the effective value or behavior in the affected project. Defaults and a session's current model/thinking selection are different states; changing a default need not change an existing conversation. Route missing skills or extension errors to their owning management skill.

Report the file or control changed, its scope, and what confirms the result. If interface control is unavailable, complete the authorized file work and state the specific reload or live check still needed. Keep failures visible and redact credential values from diagnostic output.

The Complete Pi Settings view exposes native keys and extension-owned fields. Keep unsaved edits during a conflict, refresh the saved configuration and review the merged draft before saving. `/compact` forwards custom instructions; `/reload` reports deferred or failed resource application. Model catalog refresh preserves explicit custom definitions. Use the complete model list when the scoped list does not contain the requested model.
