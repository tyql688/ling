---
name: release
description: Prepare or publish a Ling version, including version bumps, distributable builds, tags, and release verification. Use only the stages the user requested; publication requires authorization.
---

# Ling release workflow

Read root `package.json`, `apps/desktop/package.json`, `apps/desktop/scripts/stage.ts`, `apps/desktop/scripts/prune-host.ts`, `apps/desktop/scripts/package.ts`, `apps/desktop/electron-builder.yml`, and `.github/workflows/release.yml`. These files own the version, staging, target matrix, signing, and publication behavior. Use their current values when preparing a release.

## Establish the requested endpoint

| Request | Endpoint |
| --- | --- |
| Build an installer for local testing | A fresh artifact for the requested platform and architecture, with the version and smoke evidence reported |
| Prepare a new version | The requested version and release changes, verified locally; commit only if authorized |
| Push a release tag | The validated commit tagged and pushed; the tag triggers CI packaging and draft creation |
| Publish a release | The exact inspected draft made public, followed by public asset verification |

Honor authorization already given. Keep the version for a local build unless a bump was requested. Edit versions directly; `npm version` can also create a commit and tag, which require authorization. Finish the authorized preparation before seeking any missing publication authorization.

Inspect the checkout, staged work, HEAD, intended release branch, and relevant tags. Preserve existing work and use the `commit` skill for the authorized commit boundary. Keep a dirty checkout on its current branch. Obtain separate authorization to advance a remote branch when the request covers a tag only.

## Prepare and build

Use the release-preflight section of [maintain-pi-dependencies](../maintain-pi-dependencies/SKILL.md) for every release candidate before verification, packaging and tagging. Record current/latest Pi SDK, Todo, permission and voice-package versions and an upgrade or deferral decision. Registry failures and unexplained pin mismatches leave this check incomplete. For authorized updates, complete that skill's migration, compatibility repair and real acceptance before validating the final candidate; complete runtime and integration checks after installation.

1. If a version change was requested, use the specified version or choose it from the actual release delta and explain the choice. Apply the version ownership rules in [Development](../../../docs/development.md).
2. Follow [AGENTS.md](../../../AGENTS.md) for release-candidate verification, including `pnpm verify`. Reuse matching successful evidence from the current task as described in `commit`; CI's release workflow runs builds and packaging checks, while source verification remains a separate requirement.
3. When packaging is in scope, use `pnpm package` or its current-platform alias. It rebuilds, stages resources, and invokes `package.ts` with publication disabled. Directly invoking that script requires fresh builds and `stage:app` first; the release workflow demonstrates the ordered steps. Staging replaces the checkout's entire `.stage`, including standalone Node: stop Desktop instances using it or build from an isolated checkout. Use the wrapper to retain root release metadata.
4. Match the staged Node and native dependencies to the target. `stage.ts` stages the pinned Node release for its current platform and architecture, and `pnpm deploy` and `prune-host.ts` keep only that target's native addons and prebuilds; changing only electron-builder target flags does not cross-build them. Use a matching environment for another target. Bumping the pinned Node version also replaces every archive checksum in `stage.ts`.
5. Exercise the actual artifact using the isolation and cleanup procedure in [Development](../../../docs/development.md). Packaged builds refuse remote debugging switches, so drive the artifact with Computer Use or run its Host in browser mode. Inspect packaged Host dependencies, standalone Node, Web assets, and built-in skills. `.agents/skills` must not ship.
6. Record version, commit, any included uncommitted changes, platform/architecture, artifact paths, and the checks performed. Build, signature verification, installation, runtime smoke, and auto-update are separate evidence.

## Tag and publish when authorized

1. Follow the version and tag policy in [Development](../../../docs/development.md). When tagging is authorized, commit the validated candidate and tag that exact commit. Inspect existing refs first; do not replace them automatically.
2. Push only the authorized refs. For a tag-only request, push the exact tag ref. When both the intended branch and tag are authorized, push those explicit refs atomically. Read back the remote branch commit if pushed, and the peeled tag commit; an annotated tag object id differs from its commit id. Name each authorized ref in the push.
3. Find the `release.yml` run for that tag and commit and watch that specific run. Investigate failures before publication. The current native matrix is macOS arm64/x64, Windows x64, and Linux x64; derive the expected assets from the workflow and builder targets. Native jobs upload directly to a draft Release without Actions artifact storage; finalization merges the macOS manifests only after every build succeeds.
4. Inspect the draft's assets and update manifests: versions, target architectures, referenced filenames, sizes, and hashes must agree with the actual files. `latest-mac.yml` must advertise both macOS architectures after the workflow merges it.
5. Write release notes about the final behavior. Use a body file for multiline CLI input. When publication is authorized, publish the inspected draft with `gh release edit v<version> --draft=false`, then verify public state and the complete asset set.

## Signing and recovery

macOS and Windows reuse the identity from `SIGNING_CERTIFICATE` and `SIGNING_CERTIFICATE_PASSWORD`. Preserve that identity; signing-material generation or rotation requires its own authorization. `resources/release-signing.json` pins the publisher and certificate SHA-256 fingerprint consumed by the Windows updater and CI. Apple notarization and public Windows trust require separate credentials and validation. Linux artifacts are unsigned by this workflow.

macOS CI checks signatures and native architectures and executes bundled Node. Windows CI checks the pinned Authenticode certificate without importing it into the system trust store, runs the native verification test against both the executable and installer, and confirms that a modified payload is rejected. It also executes bundled Node and checks packaged resources. Windows uploads the installer, blockmap and `latest.yml`. Verify manifest hashes against the signed installer and preserve `win.forceCodeSigning` and signature verification. Verify installation and cross-version updates separately from platform build checks.

Windows update verification checks Authenticode file integrity and certificate validity and accepts an unknown certificate authority only when the signer matches the embedded certificate pin. A publisher or certificate change requires an explicit migration plan. Release notes must identify self-signing and the first-install Windows warning. Users whose installed build supports only manual updates need a one-time manual installation before automatic updates become available.

Inspect release state before a rerun. The workflow refuses asset changes after publication; draft reruns use `--clobber` and must finish every native job and manifest finalization before publication. For workflow-only repairs, push the corrected workflow to the intended branch and dispatch it with the existing `tag` input: preparation verifies the tag's version and commit, and every native job checks out that exact commit. For application or dependency fixes, prepare a new candidate. Replacing public assets or moving/deleting a published tag requires explicit authorization for that action. Report CI completion, publication and public-asset verification as separate results.
