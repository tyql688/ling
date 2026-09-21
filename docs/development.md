# Development

Run commands from the repository root. The root package declares the supported Node and pnpm versions. Install the workspace with `pnpm install --frozen-lockfile`.

## Normal development

`pnpm dev` builds Web and Host, stages the desktop runtime and resources, and opens Electron. `pnpm dev:web` builds the same Web and Host and serves the browser client. The Host prints its authenticated local launch URL. Keep its fragment token private.

Desktop runs staged resources. Editing source or rebuilding Web alone does not update an already staged Electron window. Stop the development instance before staging again; `pnpm dev` performs the complete sequence. Never replace another running instance's staged runtime.

## Contributing

Read [Architecture](architecture.md), [Design](design.md) and [AGENTS.md](../AGENTS.md) before changing ownership or interface behavior. Update all README translations when user-facing setup or the technology overview changes. Keep documentation with its existing owner; link to the file directly so local readers do not interpret a heading fragment as part of its filename.

Use AGENTS to select verification and the acceptance workflow below for live checks. Include the behavior changed, checks performed and any remaining limitations in the contribution. Keep credentials, personal configuration, generated output and temporary research outside the commit.

`pnpm build` compiles Web, Host and Desktop without creating an installer. Installer staging and packaging use the [release workflow](../.agents/skills/release/SKILL.md) and are separate from source verification.

## Versions and release tags

The source baseline is `0.1.0`. Root `package.json` is the application version authority: Host/Desktop build constants and packaged metadata derive from it. Private workspace package versions do not control the release. Protocol, storage and dependency versions have independent compatibility meanings and must not be changed to match the application version.

Use [Semantic Versioning](https://semver.org/spec/v2.0.0.html). During `0.x` development, use patch increments for compatible fixes and minor increments for new features or intentional breaking changes; document any migration. Make version edits directly: commands such as `npm version` may also create commits and tags.

- Release tags are annotated, immutable `vMAJOR.MINOR.PATCH` refs, such as `v0.1.0`. Numeric parts have no leading zeroes. The current release workflow supports stable versions only, without prerelease or build suffixes.
- A tag must point to the verified release commit and exactly match its root package version. Inspect existing refs first; use a new version for a changed release instead of moving a published tag.
- Push only the intended refs. Pushing a release tag starts native installer builds and creates a draft GitHub Release. A version edit, initial commit or ordinary branch push does not require a tag.
- Publishing a draft is a separate action after checking every target and update manifest. A successful build is not evidence of runtime acceptance or publication.

[release](../.agents/skills/release/SKILL.md) owns preparation, Pi dependency preflight, platform checks and publication steps; [commit](../.agents/skills/commit/SKILL.md) owns staging and commit review.

## Isolated acceptance

Use the runner for scripted or destructive acceptance work:

```sh
pnpm dev-run create YYYYMMDD-interface "Interface acceptance"
pnpm dev-run seed YYYYMMDD-interface
pnpm dev-run host YYYYMMDD-interface
# After stopping the Host run:
pnpm dev-run desktop YYYYMMDD-interface
```

Choose a new date-and-purpose name. The runner stores metadata, logs, evidence and fixture projects under `~/.cache/ling-dev/runs/`. `LING_DEV_ROOT` can choose another absolute directory outside this repository. The runner isolates `LING_USER_DATA_DIR`, `PI_CODING_AGENT_DIR` and `LING_HOME`; normal Ling data isolation alone does not isolate Pi credentials or feature state. These variables do not relocate custom skins in `~/.ling/skins`: inspect them without changing normal user packages.

Use `--with-auth` only when a real provider turn is needed. The runner copies the default Pi authentication file exclusively into the isolated agent directory and removes that copy after the owned child exits. Existing fixture credentials are never overwritten. Keep tokens and credential file contents out of reports. A real model turn can incur usage; a presentation-only check does not need credentials.

Keep screenshots and measurements in the run's evidence directory or outside the repository.

## Check the actual interface

Use CDP or Computer Use against the newly built candidate. [Design](design.md) owns the interface acceptance matrix. Record the build, dimensions, language, exact interactions and observed result. `window.ling` and `window.lingShell` are frozen application APIs; their calls reach the real Host and can spend tokens.

`pnpm verify` combines lint, formatting, typechecking and the test suite. Select its scope through AGENTS; a build, live acceptance and a release are separate results.

Stop the isolated run when finished and confirm its Host, Pi and plugin children exit. `pnpm dev-run list` shows retained runs; `pnpm dev-run clean` removes only expired runner-owned directories, preserving active and explicitly kept runs. Restore any temporary browser viewport or media-emulation override. Never point a cleanup command at normal Ling/Pi data.
