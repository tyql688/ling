# MCP configuration in Ling

Use this workflow for configuring MCP servers, including when the user asks in a conversation. The `ling_mcp` tool owns Ling configuration changes; the adapter's `mcp` gateway owns live status, discovery, authentication and calls. Check actual tool availability instead of assuming either exists. Use `ling_plugins` for a requested Pi package installation, update or removal; adding an MCP server does not require installing another adapter.

## Identify the switches

| Control | Meaning |
| --- | --- |
| Ling MCP feature switch | Global, off by default. Controls the bundled adapter and Ling's native MCP controls. `ling_mcp` remains available to inspect and prepare configuration while off. |
| A server's `disabled` field | Controls that server through the configuration layers. A project override can disable an inherited server without copying its credentials or changing the global entry. |
| A separately installed Pi adapter | Takes precedence over the bundled copy. Turning Ling MCP off does not disable or uninstall that package; it can continue exposing its original tools. |
| Built-in skills master switch and `ling-and-pi` switch | Control whether this guidance is loaded. They do not activate MCP or disable its configuration tool. A same-name user/project skill can shadow this one. |

Start with `ling_mcp` action `read`. It returns `feature.enabled`, `feature.revision`, document paths/revisions, service field names, and effective project configuration. Service values are intentionally omitted because credentials can appear in URLs, arguments, environment variables or custom fields. An error or null effective result is not an empty configuration. Narrow a truncated inventory by `name` or `target`.

Saving configuration never turns on Ling MCP. Keep it off when the user asks to prepare configuration without using it. Use `set_feature_enabled` only when the user authorizes enabling or disabling the global feature, with `expectedFeatureRevision` from a fresh read. A request to configure and use a service can include activation; an ambiguous scope or an explicit instruction to keep MCP off must not be broadened. Do not edit `builtin-features.json`, install a second adapter, or change Pi trust files to bypass a switch.

## Select the configuration layer

The current conversation supplies the project. Tool arguments cannot select a different project. Honor project trust; the management tool rejects requests from an untrusted project. Global changes affect all applicable projects, while project changes affect this project.

| Tool target | File | Use |
| --- | --- | --- |
| `global` | `<agent-dir>/mcp.json` | Personal Pi/Ling configuration, shared with the Pi CLI using that agent directory |
| `global-shared` | `~/.config/mcp/mcp.json` | Explicitly requested user-wide shared MCP configuration |
| `project` | `<project>/.pi/mcp.json` | Pi/Ling project configuration and overrides of inherited services |
| `project-shared` | `<project>/.mcp.json` | Explicitly requested repository/team shared configuration |

Resolve `<agent-dir>` from the current environment; it defaults to `~/.pi/agent` and can be overridden by `PI_CODING_AGENT_DIR`. Use paths returned by the tool, especially in remote/browser sessions where files belong to the Host machine. For a repository-specific request without a scope preference, use `project`; for a user-wide request, use `global`. Use shared files when the user wants other MCP clients or teammates to use them. Keep credentials out of committed project files.

In normal discovery, precedence increases through global shared, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, Pi global, project shared, and Pi project. Explicit ancestor discovery and imported sources belong to the adapter. Inspect the effective result and its source; the last file edited is not necessarily the winning entry. Do not overwrite an external host's configuration to import a service.

## Apply only the requested change

Every service mutation requires `target`, `name`, and the selected document's `expectedRevision`. Read again after each mutation before another write to that file. On `MCP_CONFIG_CHANGED`, reread, preserve the user's intended change and review the new state before retrying. Never fabricate a revision or retry a stale value indefinitely.

- `configure`: supply `server` as one service object, not an entire `mcpServers` document. Existing top-level fields are preserved; `env` and `headers` merge by key. `removeFields` explicitly deletes fields before merging. To change transport, remove obsolete transport fields such as `command` and `args` before setting `url`. Changing a URL, executable or socket also requires explicitly clearing existing connection-bound fields listed by the tool (such as headers, environment or OAuth) through `removeFields`; supply replacements only for the new target. This prevents silently forwarding the old target's credentials. Removing `env` or `headers` clears that entire map; only do so when requested. New transport entries default to `approveTools: true` unless explicitly set.
- `set_server_enabled`: pass `enabled: false` to disable a server at the chosen layer. To disable a global service only here, use `target: "project"`; it writes only the disabled override. `enabled: true` explicitly enables at that layer.
- `reset_server_enabled`: removes only that layer's disabled override and retains its other fields. The effective state then inherits from lower layers and can still be disabled.
- `remove`: removes that layer's whole entry. Removing an override may reveal a lower-priority service; it is not the same as disabling the effective service everywhere.
- `reload`: reconciles resources after authorized manual configuration edits. Tool mutations already do this; avoid redundant reloads.

Keep the requested command and arguments as separate fields. Use environment references such as `${SERVICE_TOKEN}` for secrets, with the variable available to the Host process. Do not place real tokens in chat, tool arguments, committed files or diagnostic output. Preserve existing authentication fields without reading their values into the model context. If a service needs OAuth, use the available runtime authentication flow after activation; do not report it connected while authorization is pending. Installing a service does not authorize arbitrary calls to it.

## Verify activation

The result distinguishes the saved switch/configuration from `reload`. Inspect `projectError`, `sessionError`, `sessions.failed` and `sessions.deferred`. Enabling or reloading can connect enabled services for discovery according to the adapter lifecycle, even without an explicit connect/tool call. Keep the feature or service off when the user requires no connection. Busy sessions apply changes after the current run; finish the turn and check in the next turn rather than looping on reload or using stale tools. Disabling during a run can likewise remain pending until that run ends. Preserve unrelated service configuration and session history.

When the feature is off, report that configuration was saved and that the bundled adapter remains off. If a community adapter is installed, describe its independent state instead of claiming all MCP execution stopped. When enabled and reloaded, inspect live `mcp` status, connect/discover the intended service, and use only an authorized harmless check. A successful file save, cached tool list or scheduled reload is not proof of a live connection. Keep connection failures, missing environment variables and pending OAuth visible.

If `ling_mcp` is unavailable in an older host, use Settings → MCP services when UI control is available. Otherwise complete authorized file edits without changing the feature switch and identify the remaining UI enable/reload step. The adapter's optional URL-install action can add and connect a remote endpoint in the current session, but does not replace Ling's full configuration management or prove other sessions reloaded. Prefer `ling_mcp` whenever available, including for URL services.
