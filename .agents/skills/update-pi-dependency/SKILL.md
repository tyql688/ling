---
name: update-pi-dependency
description: Update Ling's embedded Pi dependency, audit upstream API and behavior changes, integrate applicable stable features, and verify the complete Pi package closure. Use for any Pi version bump or compatibility review in this repository.
---

# Update Ling's Pi dependency

A Pi bump is an SDK migration. Finish with a coherent dependency graph, explicit decisions for material upstream changes, and evidence from the affected Ling integration paths. [Architecture](../../../docs/architecture.md) identifies code owners. After establishing the upstream delta, use the [upgrade checklist](references/upgrade-checklist.md) to classify changes and select compatibility checks.

## Establish scope and source identity

1. Record checkout status, the installed Pi version, and the exact pins in `packages/core/package.json`, `packages/host/package.json` and `packages/builtin-extensions/package.json`. Preserve unrelated edits and dependency changes. Include bundled Todo and permission compatibility using the [extension checklist](../maintain-pi-dependencies/references/extension-upgrade-checklist.md). When their versions also change, complete their migration with [maintain-pi-dependencies](../maintain-pi-dependencies/SKILL.md) in the same task without restarting this SDK workflow.
2. For a focused compatibility review, inspect the installed declarations, executable code, and affected Ling owners. A review does not require a version change or a full upstream clone. Use the remaining migration steps when a bump is requested.
3. Resolve the requested target from npm metadata. For an unspecified update, use the latest published stable release; a default-branch commit is not a published version. Record current/target versions, publication times, repository, and `gitHead`.
4. Clone or fetch the published repository with Git under one uniquely named temporary root and materialize the current and target `gitHead` commits. Record their ancestry. Use actual history and trees for the migration audit; tags, GitHub API summaries, generated patches, and source archives do not establish that history. If a commit cannot be retrieved, report the source-audit gap instead of substituting another revision.
5. Read every changelog entry between the versions. Diff public exports, SDK/config documentation, stable Core source, and relevant `pi-ai` model/provider changes. Inspect target-to-default-branch drift only when needed to investigate a discrepancy or answer an upstream-status question; keep unreleased findings separate from the shipped delta.
6. Compare changed APIs, events, and dependency edges with the target npm artifact's executable `dist`, declarations, and manifest. The Git tree describes source intent; the published artifact defines what Ling runs. Record mismatches and preserve compatibility required by the installed code.
7. Classify each material change using the checklist's decision rules. Record the published-source evidence, affected Ling behavior, and concrete owner or product-boundary reason.

## Update the dependency closure

- Keep exact, matching coding-agent versions in `packages/core` and `packages/host` `dependencies` and `packages/builtin-extensions` `devDependencies`. Keep the built-in extensions' public peer range as `"*"`; their development pin supplies the workspace type identity. Check both bundled extensions' published peers and actual behavior against the target SDK.
- Use targeted package-manager updates and inspect the lockfile diff. Preserve unrelated overrides and patches; reject incidental dependency churn without a graph reason.
- Run `pnpm -r list --depth Infinity` across the workspace and `pnpm -r why` for surprising edges. Compare transitive `@earendil-works/pi-*` versions with the target's published dependency graph. Resolve unexplained duplicates and incompatible SDK type identities; do not force every package to share a version number if upstream deliberately publishes a different compatible graph. Keep command output as evidence rather than adding a second dependency parser to Ling.
- Import the published package root in a plain Node process from `packages/core`. Type declarations can pass while a missing published dependency prevents runtime loading. If no fixed release exists, repair a demonstrated manifest defect with exact-version `packageExtensions` and record the defect. Reinspect every such repair on later bumps and remove it when the executable dependency edge disappears or upstream declares it. Source-only exports and development dependencies do not justify shipping an experimental runtime.

## Migrate affected behavior

- Audit newly deprecated exports in the version-specific source and declaration diff against Ling's direct Pi imports. Replace affected uses and use ESLint's deprecation rule, typechecking, and runtime evidence to verify them. Do not maintain a duplicate deprecated-symbol registry or rely on repository-wide name matches.
- For each `adapt` or `expose` decision, trace the changed API through its callers and the existing Ling domain, including execution, persistence, and rendering where affected. Select the corresponding checklist rows and keep evidence for the observed behavior; compilation alone does not settle compatibility.
- Remove a Ling workaround only when the target implementation owns the complete behavior it covered. Follow `AGENTS.md` for import and product boundaries; a dependency upgrade does not authorize a new product surface.

## Verify and report

1. Recheck all three pins, installed version, workspace dependency graph, deprecated imports, and plain-Node package-root import. An SDK upgrade affects multiple owners, so run `pnpm verify` as described in [AGENTS.md](../../../AGENTS.md).
2. Launch an isolated fixture following [Development](../../../docs/development.md). Confirm Host readiness, project open, session creation/resume, settings/model catalog load, and persistence across a full restart.
3. Exercise the selected compatibility checks for each `adapt` or `expose` decision and relevant inherited behavior. Follow `AGENTS.md` for real-model and tool-approval checks when runtime owners change. A loopback provider can make failure cases deterministic but does not replace that real flow. Use an authorized configured provider, preserve credentials/settings, and clean up only sessions created by the run.
4. When package contents or dependency layout changes, inspect the staged runtime and import Pi with staged Node from the staged Host dependency tree. If installer or release work is requested, follow `release` for that endpoint.
5. Complete fixture cleanup through Development. Deferred features need a source-backed boundary decision, not invented runtime results.
6. Report exact old/new versions, adapted/exposed features, inherited fixes, deferred items, checks performed, and unverified boundaries. For a review without a bump, report the inspected version and findings. Commit, push, tag, and publication follow the user's requested scope.
