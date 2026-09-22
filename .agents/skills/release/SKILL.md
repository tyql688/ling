---
name: release
description: Prepare or publish a Ling version, including version bumps, distributable builds, tags, and release verification. Use only the stages the user requested; a local build or version bump does not authorize publishing.
---

# Ling release workflow

Read root `package.json`, `apps/desktop/package.json`, `apps/desktop/scripts/stage.ts`, `apps/desktop/scripts/package.ts`, `apps/desktop/electron-builder.yml`, and `.github/workflows/release.yml`. These files own the version, staging, target matrix, signing, and publication behavior. Recheck them rather than treating this skill as another build configuration.

## Establish the requested endpoint

| Request | Endpoint |
| --- | --- |
| Build an installer for local testing | A fresh artifact for the requested platform and architecture, with the version and smoke evidence reported |
| Prepare a new version | The requested version and release changes, verified locally; commit only if authorized |
| Push a release tag | The validated commit tagged and pushed; the tag triggers CI packaging and draft creation |
| Publish a release | The exact inspected draft made public, followed by public asset verification |

Honor authorization already given. A local build does not require a version bump. Edit versions directly rather than using `npm version`, which can create a commit and tag. Finish the authorized preparation before seeking any missing publication authorization.

Inspect the checkout, staged work, HEAD, intended release branch, and relevant tags. Preserve existing work and use the `commit` skill for the authorized commit boundary. Do not switch a dirty checkout or assume that a tag request also authorizes advancing a remote branch.

## Prepare and build

Use the release-preflight section of [maintain-pi-dependencies](../maintain-pi-dependencies/SKILL.md) for every release candidate before verification, packaging and tagging. Record current/latest Pi SDK, Todo and permission-package versions and an explicit upgrade or deferral decision. Registry failures and unexplained pin mismatches leave this check incomplete. For authorized updates, complete that skill's migration, compatibility repair and real acceptance before validating the final candidate; a version report or installation alone does not complete an upgrade.

1. If a version change was requested, use the specified version or choose it from the actual release delta and explain the choice. Apply the version ownership rules in [Development](../../../docs/development.md).
2. Follow [AGENTS.md](../../../AGENTS.md) for release-candidate verification, including `pnpm verify`. Reuse matching successful evidence from the current task as described in `commit`; CI's release workflow runs builds and packaging checks, so it does not replace source verification.
3. When packaging is in scope, use `pnpm package` or its current-platform alias. It rebuilds, stages resources, and invokes `package.ts` with publication disabled. Directly invoking that script requires fresh builds and `stage:app` first; the release workflow demonstrates the ordered steps. Staging replaces the checkout's entire `.stage`, including standalone Node: stop Desktop instances using it or build from an isolated checkout. Never bypass the wrapper and lose root release metadata.
4. Match the staged Node and native dependencies to the target. `stage.ts` stages Node for its current platform and architecture; changing only electron-builder target flags does not cross-build that runtime. Use a matching environment for another target.
5. Exercise the actual artifact using the isolation and cleanup procedure in [Development](../../../docs/development.md). Inspect packaged Host dependencies, standalone Node, Web assets, and built-in skills. `.agents/skills` must not ship.
6. Record version, commit, any included uncommitted changes, platform/architecture, artifact paths, and the checks performed. Build, signature verification, installation, runtime smoke, and auto-update are separate evidence.

## Tag and publish when authorized

1. Follow the version and tag policy in [Development](../../../docs/development.md). When tagging is authorized, commit the validated candidate and tag that exact commit. Inspect existing refs first; do not replace them automatically.
2. Push only the authorized refs. For a tag-only request, push the exact tag ref. When both the intended branch and tag are authorized, push those explicit refs atomically. Read back the remote branch commit if pushed, and the peeled tag commit; an annotated tag object id differs from its commit id. Never use a broad tag push.
3. Find the `release.yml` run for that tag and commit and watch that specific run. Investigate failures before publication. The current native matrix is macOS arm64/x64, Windows x64, and Linux x64; derive the expected assets from the workflow and builder targets. Native jobs upload directly to a draft Release without Actions artifact storage; finalization merges the macOS manifests only after every build succeeds.
4. Inspect the draft's assets and update manifests: versions, target architectures, referenced filenames, sizes, and hashes must agree with the actual files. `latest-mac.yml` must advertise both macOS architectures after the workflow merges it.
5. Write release notes about the final behavior. Use a body file for multiline CLI input. When publication is authorized, publish the inspected draft with `gh release edit v<version> --draft=false`, then verify public state and the complete asset set.

## Signing and recovery

macOS uses the existing reusable identity from `SIGNING_CERTIFICATE` and `SIGNING_CERTIFICATE_PASSWORD`. Windows uses separate `WINDOWS_SIGNING_CERTIFICATE` and `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` secrets for a certificate trusted by ordinary Windows installations. Preserve the macOS identity when configuring Windows signing; do not generate or rotate signing material as a routine fix. The existing self-signed macOS certificate does not establish Apple notarization or public Windows trust. Linux artifacts are unsigned by this workflow.

macOS CI checks signatures and native architectures and executes bundled Node. Windows CI requires Authenticode status `Valid`, matching electron-updater's trust requirement; an untrusted or expired signature must fail before asset upload. Importing a self-signed certificate into CI's trust store does not establish trust on users' machines. Check the new publisher against the installed version's `app-update.yml`; a publisher identity change can require a one-time manual Windows upgrade. Neither CI signature check runs the Electron UI or proves installation and auto-update behavior.

Inspect release state before a rerun. The workflow refuses asset changes after publication; draft reruns use `--clobber` and must finish every native job and manifest finalization before publication. For workflow-only repairs, push the corrected workflow to the intended branch and dispatch it with the existing `tag` input: preparation verifies the tag's version and commit, and every native job checks out that exact commit. For application or dependency fixes, prepare a new candidate. Replacing public assets or moving/deleting a published tag requires explicit authorization for that action. Report the completed stage and remaining work rather than treating a green CI run as a published release.
