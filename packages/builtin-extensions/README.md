# Built-in Pi tools

Ling compiles these extensions into the Pi worker and loads them for every session.

Use an extension to provide Ling tools. Write agent instructions as a built-in skill in `builtin-skills/`. User extensions load before Ling's inline extensions and take precedence when tool names conflict.

## Dependencies

The package imports the public Pi SDK, Contracts and TypeBox. `manage-plugins`, `manage-mcp` and `companion-tools` export factories that receive Host callbacks. `generate-image` receives the session's Pi ModelRuntime. These factories receive their dependencies from the Pi adapter.

`packages/core/src/pi-sdk/entrypoints/pi-worker.ts` constructs `lingExtensionFactories(pluginTools, companionTools, features, mcpTools)` with the package-operation, companion and MCP callbacks. Project services receive these factories as dependencies and merge them into the SDK resource loader alongside the image-generation factory.

It is a direct dependency of `@ling/core`. The Host build bundles the extension registry into the Pi worker for use in deployed builds. After a fresh Host build, inspect its entry and shared chunks for unresolved package imports:

```
rg '@ling/builtin-extensions' packages/host/dist -g '*.js'
```

The expected result is zero unresolved package imports (`rg` exits 1).

## Adding one

1. Create `src/plugins/<name>/index.ts` with a Pi extension factory, or a `create*` factory receiving named dependencies when it needs Host capabilities.
2. Add its named inline entry to `lingExtensionFactories()` in `src/index.ts` and supply dependencies from the Pi entrypoint.
3. Select checks from `AGENTS.md`. For execution or UI changes, check registration, model turns, tool approval, and affected reload and cleanup paths. For prose edits, check the documented behavior against its implementation. Inspect Pi's extension diagnostics when exercising project open or resource reload.

Co-locate tool policy with its extension. Pi owns its built-in shell tools, including shell selection, command prefixes and timeouts.

Use stable `ling-<concern>` inline names from the registry. Pi uses these identities in extension sources and diagnostics.

## Claiming a tool name

The installed Pi SDK keeps the first extension registration for each tool name. Its resource loader appends Ling's inline factories after file-based extensions, so an earlier user extension with the same name takes precedence. The selected extension tool replaces Pi's stock tool of that name. Conflicts produce diagnostics while both extensions remain loaded.

Use distinct names for new Ling capabilities. When replacing a stock tool, inspect the active tool source and conflict diagnostics. An earlier user registration determines which implementation runs.

## Extensions

| Name | Does |
| --- | --- |
| `ling-mcp` | Provides `ling_mcp` for MCP configuration edits and runtime reload |
| `ling-plugins` | Provides `ling_plugins` for Pi package operations and resource reload through Host |
| `ling-companions` | Registers the companion tools declared in `@ling/contracts/companion-tools` (questions, background tasks, schedules) and forwards each call to the Host |
| `ling-image-generation` | Exposes Pi image-model discovery and generation through the session's ModelRuntime |
