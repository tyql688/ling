# Development

Run commands from the repository root. The root package declares the supported Node and pnpm versions. Install the workspace with `pnpm install --frozen-lockfile`.

## Normal development

`pnpm dev` builds Web and Host, stages the desktop runtime and resources, and opens Electron. `pnpm dev:web` builds Web and Host and serves the browser client. Host prints an authenticated local launch URL whose fragment token needs to stay private.

Desktop runs the staged resources. Source edits and Web rebuilds reach Electron after restaging and reopening it. Stop every development instance using the staging directory before restaging. `pnpm dev` runs the build, staging and launch sequence.

## Contributing

Read [Architecture](architecture.md), [Design](design.md) and [AGENTS.md](../AGENTS.md) before changing code responsibilities or interface behavior. Update all README translations when setup instructions or the technology overview changes. Edit the document responsible for the topic. Use links to files: local readers can interpret heading fragments as part of a filename.

Select verification through AGENTS and use the acceptance workflow below for live checks. Report the changed behavior, checks performed and remaining limitations. When a commit is requested, include the relevant project files. Keep credentials, personal configuration, generated output and temporary research in their separate local locations.

`pnpm build` compiles Web, Host and Desktop. Use the [release workflow](../.agents/skills/release/SKILL.md) to stage resources and create installers. Check source and packaged artifacts separately.

## Versions and release tags

Host/Desktop build constants and packaged metadata read the application version from root `package.json`. Private workspace package versions describe those packages. Protocol, storage and dependency versions follow their own compatibility changes.

Use [Semantic Versioning](https://semver.org/spec/v2.0.0.html). During `0.x` development, increment the patch version for compatible fixes and the minor version for features or intentional breaking changes. Document migrations. Edit version fields directly; `npm version` can also create a commit and tag.

- Use annotated, immutable `vMAJOR.MINOR.PATCH` release tags, such as `v0.1.0`. Write numeric parts without leading zeroes. The release workflow accepts stable versions, with prerelease and build suffixes excluded.
- Point each tag to the verified release commit with a matching root package version. Inspect existing refs before tagging. A changed published release needs a new version and tag.
- Push the authorized refs by name. A release-tag push starts native installer builds and creates a draft GitHub Release. Create tags when preparing a release; ordinary version edits and branch pushes can stand on their own.
- Check every target and update manifest before publishing the draft. Record build results, runtime acceptance and publication status separately.

Use [release](../.agents/skills/release/SKILL.md) for preparation, Pi dependency preflight, platform checks and publication. Use [commit](../.agents/skills/commit/SKILL.md) for staging and commit review.

## Isolated acceptance

Use the runner for scripted or destructive acceptance work:

```sh
pnpm dev-run create YYYYMMDD-interface "Interface acceptance"
pnpm dev-run seed YYYYMMDD-interface
pnpm dev-run host YYYYMMDD-interface
# After stopping the Host run:
pnpm dev-run desktop YYYYMMDD-interface
```

Choose a new date-and-purpose name. The runner stores metadata, logs, evidence and fixture projects under `~/.cache/ling-dev/runs/`. Set `LING_DEV_ROOT` to use another absolute directory outside this repository. Isolate all three locations: `LING_USER_DATA_DIR` for application data, `PI_CODING_AGENT_DIR` for Pi credentials and state, and `LING_HOME` for Ling feature data. Custom skins remain in `~/.ling/skins`; use read-only inspection for those normal user packages.

Add `--with-auth` when a provider turn needs credentials. The runner copies the default Pi authentication file into the isolated agent directory and removes its copy after the child exits. It preserves existing fixture credentials. Redact tokens and credential contents from reports. Model turns can incur usage; interface-only checks can run with empty credentials.

Keep screenshots and measurements in the run's evidence directory or another location outside the repository.

## Check the interface

Use CDP or Computer Use against the rebuilt candidate. Packaged builds reject remote debugging switches and need Computer Use. Development builds support CDP. Follow the interface acceptance matrix in [Design](design.md) and record the build, dimensions, language, interactions and observed results. `window.ling` and `window.lingShell` are frozen application APIs that call Host and can spend tokens.

`pnpm verify` combines lint, formatting, typechecking and tests. Select its scope through AGENTS. Report builds, live acceptance and releases as separate results.

Stop the isolated run and confirm its Host, Pi and plugin children exit. `pnpm dev-run list` shows retained runs. `pnpm dev-run clean` removes expired runner-owned directories and preserves active and explicitly kept runs. Limit cleanup to these fixture locations. Restore temporary browser viewport and media-emulation overrides.
