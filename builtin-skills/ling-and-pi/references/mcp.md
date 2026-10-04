# MCP configuration in Ling

Use `ling_mcp` for configuration changes and Settings → MCP services for live status, reconnect, sign-in and sign-out. Pi's built-in MCP extension owns discovery, authentication, connections, resources and tool calls. Check actual tool availability. The bundled MCP extension loads configured servers. Use `ling_plugins` for authorized Pi package operations.

## Identify the switches

| Control | Meaning |
| --- | --- |
| Ling MCP switch | Edits Pi's global `builtin:mcp` selection and reflects changes made through the CLI. Existing saved choices are preserved; new installations follow Pi's default. `ling_mcp` remains available while execution is off. |
| A server's `enabled` field | `false` disables the service. Complete connections default to enabled; project inheritance overrides use the global value when this field is absent. |
| Pi extension selection | Global and trusted project filters resolve in Pi; `-builtin:mcp` disables and `+builtin:mcp` enables the official extension. An installed extension that owns `/mcp` takes precedence; it retains its own commands and lifecycle. |
| Built-in skills switches | Control whether this guidance is loaded, independently of MCP activation. A same-name user/project skill can shadow it. |

Start with `ling_mcp` action `read`. The result includes feature state/revision, file paths/revisions, service field names, validity diagnostics and the effective project configuration. Values are omitted because credentials can occur in URLs, arguments, environment variables and custom fields. Treat an error or null result as an unavailable configuration read. Narrow truncated inventories by `name` or `target`.

Saving configuration preserves the feature switch. Use `set_feature_enabled` with a fresh `expectedFeatureRevision` only when activation or deactivation is authorized. A request to configure and use a service can include activation. Honor disabled features and declined trust decisions. Activation or loading an alternative adapter requires authorization.

## Select the configuration layer

Management requests use the conversation’s open, trusted project. Global changes reconcile all open projects; project changes reconcile that project.

| Tool target | File | Use |
| --- | --- | --- |
| `global` | `<agent-dir>/mcp.json` | Personal Pi/Ling configuration shared with the CLI using that agent directory |
| `project` | `<project>/.pi/mcp.json` | A complete server entry or activation/exposure overrides for a same-name global entry |

Resolve the agent directory from returned paths. It defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` can override it. Paths belong to the Host machine in browser sessions. Default a repository-specific request to `project` and a user-wide request to `global`. Keep credentials out of committed files.

Files use strict JSON with an `mcpServers` object and optional `autoEnableCodemode` boolean. A project entry with a connection replaces the complete same-name global entry. An entry containing only `enabled`, `exposure` or `toolExposure` inherits the global connection and credentials; for example, `{ "enabled": false }` disables an inherited service in that project. Inheritance requires a valid global service. Legacy and shared-client files are visible as import sources; import requested services while preserving the source files. Incompatible fields produce diagnostics and require correction before the service runs. An invalid project entry blocks the same-name global service in that project.

## Configure a service

For a complete connection, supply exactly one transport: `command` with optional `args`, `env` and `cwd`, or an HTTP `url` with optional `headers`, `oauth` and `auth`. Names allow letters, digits, `_` and `-`; hyphens become underscores in model-facing tool and namespace names, so names such as `my-service` and `my_service` conflict. `timeout` is a positive number of seconds. Environment/header values can reference `${SERVICE_TOKEN}` from the Host environment. URLs must be literal HTTP(S) URLs. Preserve authentication values without reading them into the model context.

`description` summarizes the service for Pi’s system prompt and tool search. Set it to a short description of the service’s capabilities. HTTP services can set `oauth.clientName` when a server requires a particular client registration name. Global services can use `auth: { "provider": "<provider-id>" }` to send the current credential from that Pi provider’s login. This requires HTTPS or loopback HTTP and is forbidden in project configuration. Use Settings → Models for that provider’s login; Pi refreshes credentials without copying them into MCP configuration.

`exposure` controls discovery: `codemode` (default) lists a service summary and discovers tools through `searchTools()`, with instructions and tool names available through `describeNamespace()`. `codemode-deferred` is accepted as an alias for `codemode`. `deferred` uses tool search before direct calls, `direct` declares tools to the model, and `hidden` makes tools unreachable. `toolExposure` selects exposure per tool or pattern. Tool calls, including Codemode's nested calls, pass through Ling's access-mode permission rules. Each tool call requires the permissions granted by the access-mode rules.

Every service mutation requires `target`, `name` and a fresh document `expectedRevision`. Reread after each mutation. On `MCP_CONFIG_CHANGED`, preserve the user's draft, reread and review the concurrent change before retrying.

- `configure` accepts one server object. Existing fields are preserved and `env`/`headers` merge by key. `removeFields` explicitly deletes fields before merging. When changing a URL or executable, explicitly clear connection-bound fields listed by the tool, including credentials, and supply replacements only for the new endpoint. A saved entry must describe a complete transport or a valid project inheritance override.
- `set_server_enabled` changes `enabled` on an existing entry, including a project inheritance override. Use `configure` to create an entry.
- `reset_server_enabled` removes that entry's `enabled` field, restoring that entry's default or inherited activation state.
- `remove` removes the selected entry. Removing a project entry may expose a global service with the same name.
- `reload` reconciles resources after manual edits. Tool mutations already request reconciliation.

## Verify activation

Inspect `projectError`, `sessionError`, `sessions.failed` and `sessions.deferred` in the reload result. Enabled services connect for discovery in the background at session startup. The first prompt waits briefly only for servers with direct tools; Codemode and tool search wait for the services they need when called. Keep the feature or server off when no connection is authorized. Busy sessions apply changes after their current turn; verify application on the next turn.

Refresh the current conversation's status in Settings → MCP services, or run `/mcp` to open the same view. The timestamp identifies a snapshot of Pi's own connection report. Reconnect and MCP OAuth sign-in/sign-out use that session’s official command. Services using `auth.provider` link to the provider login controls instead. Check a permitted harmless tool call or resource read to verify execution. Verify connection state separately from configuration, discovery and scheduled reloads. Report failures and pending OAuth explicitly. A separately installed extension retains its independent state when Ling's MCP switch is off.

If `ling_mcp` is unavailable, use Settings → MCP services or complete authorized file edits and identify the remaining reload/live check. Report which controls were exercised and which remain unverified.
