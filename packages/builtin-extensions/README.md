# @ling/builtin-extensions

Pi extensions Ling compiles in and loads for every session.

These implement Ling-owned tool behaviour. If the agent merely needs instructions, write a built-in skill in `builtin-skills/`; use an extension when the tool surface itself has to change. Inline registration does not guarantee precedence over user extensions.

## Boundaries

The package uses the public Pi SDK, Contracts and TypeBox. It does not import Host, Desktop or renderer internals. `bash-guard` exports a standard Pi extension factory. `manage-plugins` exports `createPluginTools(host)` and `companion-tools` exports `createCompanionTools(host)`; both require Ling's explicit Host callbacks and cannot run independently by copying their directories into Pi's extension roots.

`packages/core/src/pi-sdk/entrypoints/pi-worker.ts` constructs `lingExtensionFactories(pluginTools, companionTools)` with the package-operation and companion callbacks. Project services receive these factories as dependencies and merge them into the SDK resource loader. The package does not locate Host services globally.

It is a direct dependency of `@ling/core`. The Host build bundles the extension registry into the Pi worker graph so a deployed Host does not depend on workspace resolution. After a fresh Host build, inspect its entry and shared chunks for unresolved package imports:

```
rg '@ling/builtin-extensions' packages/host/dist -g '*.js'
```

There must be no unresolved package import; `rg` exits 1 when no match is found.

## Adding one

1. Create `src/plugins/<name>/index.ts` with a Pi extension factory, or a `create*` factory receiving named dependencies when it needs Host capabilities.
2. Add its named inline entry to `lingExtensionFactories()` in `src/index.ts` and supply dependencies from the Pi entrypoint.
3. Select checks from `AGENTS.md`. Execution or UI changes need actual registration, model/tool-approval and relevant reload/cleanup checks; prose-only changes do not. Inspect Pi's extension diagnostics when exercising project open or resource reload.

Co-locate tool policy with its extension. `bash-guard/timeout.ts` owns the timeout interpretation shared by the shell tools.

Use stable `ling-<concern>` inline names from the registry. Pi uses these identities in extension sources and diagnostics.

## Claiming a tool name

The installed Pi SDK keeps the first extension registration for each tool name. Its resource loader appends Ling's inline factories after file-based extensions, so an earlier user extension with the same name takes precedence. The selected extension tool replaces Pi's stock tool of that name. Conflicts produce diagnostics while both extensions remain loaded.

Use distinct names for new Ling capabilities. When replacing a stock tool, inspect the active tool source and conflict diagnostics; inline registration alone cannot enforce Ling's policy over a user's replacement.

## Extensions

| Name | Does |
| --- | --- |
| `ling-bash-guard` | Defaults foreground bash/Windows PowerShell calls to 120 seconds and rejects timeouts above one hour |
| `ling-plugins` | Provides `ling_plugins` for Host-owned Pi package operations and resource reconciliation |
| `ling-companions` | Registers the companion tools declared in `@ling/contracts/companion-tools` (questions, background tasks, schedules) and forwards each call to the Host |
