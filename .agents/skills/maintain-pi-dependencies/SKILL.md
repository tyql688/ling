---
name: maintain-pi-dependencies
description: Upgrade Ling's bundled Pi Todo, permission and voice packages and coordinate embedded Pi SDK migrations. Audit published source changes, update exact pins, adapt affected behavior, remove superseded workarounds, and verify real interactions and packaged resources. Also use for the dependency preflight before each release.
---

# Maintain Pi dependencies

Treat an upgrade as an integration migration. Carry an authorized update through dependency installation, source adaptation, regression repair, real acceptance and build verification. A version table, changelog summary, proposed patch or successful installation alone does not complete it. Do not stop for another approval of work already covered by the update request.

Use the migration workflow below when asked to update these dependencies. An unspecified update targets the latest published stable versions within the requested scope; preserve an explicitly requested version. For a check-only request or release preflight, use the “Check before a release” section below. [update-pi-dependency](../update-pi-dependency/SKILL.md) owns the SDK migration steps; this skill owns bundled extension migration and their compatibility with that SDK. [release](../release/SKILL.md) owns installer and publication work, which an update does not imply.

## Establish scope and the current integration

1. Record checkout status and preserve unrelated edits. Read the manifests, lockfile, `pnpm-workspace.yaml`, installed artifacts and affected source. Identify exact current and target versions, relevant overrides, patches and any actual fork. Do not infer a fork from a Ling adapter or a package name.
2. Inventory the SDK pins defined by [update-pi-dependency](../update-pi-dependency/SKILL.md) and all bundled extensions, even when updating only one. The extensions are exact Host dependencies: `@juicesharp/rpiv-todo`, `@gotgenes/pi-permission-system` and `@earendil-works/pi-voice`.
3. Trace the affected runtime path using [Architecture](../../../docs/architecture.md): adapter planning and feature switches, extension loading, recorded provenance, original tool execution, session replay, Host projection, Contracts validation, Web interactions and Desktop staging. Inspect implementation and tests rather than trusting comments or permissive peer ranges.
4. Distinguish the bundled copy from a user's Pi installation. The user-installed package wins; changing Ling's pin does not update it. Preserve user packages, settings and rule files. Test user-installed precedence in an isolated fixture.

## Audit the published change

1. Query `pnpm view <package> dist-tags --json`. For each current and target version, query `pnpm view <package>@<version> version repository gitHead time dist.integrity peerDependencies dependencies engines --json`. Record publication and source identities. Registry failures leave the lookup unresolved; they never establish that the current pin is latest.
2. Fetch the published npm artifacts into a uniquely named temporary directory outside the repository. Inspect manifests, declared `pi.extensions`, executable entry files, declarations, configuration schemas, dependency/assets layout and notices. A default-branch checkout is not the published artifact.
3. Clone or fetch the actual upstream Git repository into that temporary directory and materialize both published `gitHead` commits. Read every intervening changelog and compare the relevant source trees and history. If metadata lacks `gitHead`, verify a release tag against the artifact and record the weaker mapping; do not silently substitute another revision. Compare source changes with the executable artifact that Ling will load.
4. For a fork or patch, establish the upstream base, local head and retained delta. Check every retained change against the target. Port necessary behavior and resolve conflicts in the authorized fork/patch scope. Remove a local workaround only when the new upstream implementation covers its complete invariant. Do not discard Ling-specific behavior merely to make a dependency update pass.
5. Classify every material change using the [extension upgrade checklist](references/extension-upgrade-checklist.md): `adapt`, `expose`, `inherited` or `defer`. Record source evidence, affected behavior and its owner. In-scope breaking changes require migration, not deferral because they need more than a version edit. Product-boundary changes and experimental/TUI-only features require an explicit reason to defer.

## Update and migrate

1. For an SDK target change, complete [update-pi-dependency](../update-pi-dependency/SKILL.md) in the same task. Use this skill's extension checklist for all bundled packages; do not recursively restart the workflows. An extension-only update still checks the installed SDK for compatibility.
2. Apply targeted exact dependency updates, such as `pnpm --filter @ling/host add --save-exact @juicesharp/rpiv-todo@<version>` or the corresponding permission or voice package. Review manifests and the lockfile against the baseline. Preserve unrelated patches, overrides and package changes; explain any required transitive movement.
3. Implement each `adapt` and applicable `expose` decision through its owning source, contracts, consumers and persistence path. Update changed tool names, arguments, results, events, configuration semantics and renderers where needed. Handle valid new fields that a projection would otherwise drop. Preserve old session readability and unknown tool rendering; widen provenance/version compatibility only after verifying the new result contract.
4. Preserve feature switches, user-installed precedence and canonical upstream configuration ownership. Keep original tools responsible for Todo mutations and replay. Preserve permission rule precedence, approval decisions, full-access transitions and restoration of filtered tools. Voice keeps upstream settings, model caches and file tools while Ling owns client recording, cancellation and draft insertion. If upstream adds reconciliation or lifecycle behavior, verify it before removing Ling's equivalent so one request cannot run duplicate follow-ups.
5. Remove superseded compatibility code and update owning documentation and localized UI text when behavior changes. Use the existing control and interaction owners. Do not copy upstream implementations into Ling or add a parallel extension configuration format.
6. Inspect `pnpm -r list --depth Infinity` and focused `pnpm -r why <package>` output. Resolve incompatible peers and unexplained duplicate Pi type/runtime identities against the target's published graph. Recheck Node requirements, runtime imports, licenses/notices, package size, native build policy and WASM resolution. Do not enable unrelated install scripts or force a falsely uniform transitive version to conceal incompatibility.

## Verify the migrated candidate

1. Select the changed surfaces from the checklist and add or extend regression tests for concrete contract, persistence or lifecycle failures. Run affected lint/types/tests. SDK and broad runtime migrations require `pnpm verify`; follow [AGENTS.md](../../../AGENTS.md) for proportional test selection. Repair failures attributable to the migration instead of reporting a pin update as complete.
2. Build the affected Host and Web. Load the published SDK root in plain Node and load the actual extension entries through Pi. Inspect a fresh isolated staged Host with its standalone Node when dependency or package contents change, including declared entries, transitive dependencies, WASM assets and native voice libraries. Preserve any running application's `.stage`.
3. Follow [Development](../../../docs/development.md) for an isolated `pnpm dev-run` fixture. Exercise a real model turn and actual tool approval when runtime behavior changes. Verify the selected flows in Web and Desktop, enable/disable, resource reload, resume and full restart. Exercise both the bundled copy and a fixture Pi-installed copy. Loopback providers can reproduce failures but do not replace real-model acceptance.
4. Complete fixture cleanup through Development and retain the selected checklist results. Report unavailable platform checks as gaps; do not infer another platform's acceptance from a successful local build.

## Check before a release

Run a fresh dependency preflight before verification, packaging and tagging for every release candidate. Record the date, checkout and requested release endpoint. Resolve current/latest stable versions and inspect their source changes, compatibility and dependency graph using the same owners above. Record one row per dependency with bundled/available version, source, decision (`current`, `upgrade`, `defer` or `unverified`), concrete reason and required checks.

A check-only or release request does not automatically opt into every new major release. Complete already authorized upgrades using the full migration workflow before validating the final candidate. A deliberate deferral needs its specific compatibility or product reason; registry failures and unexplained pin mismatches leave preflight incomplete. Recheck relevant evidence after candidate changes. Do not change pins automatically during CI packaging or add another dependency parser, lockfile or enforcement script.

## Completion

An upgrade is complete when the requested exact versions are installed and locked, affected Ling behavior is migrated, required checks pass against that candidate, and remaining platform or upstream gaps are explicit. Report old/new versions, published-source identities, adapted/exposed behavior, inherited fixes, retained/removed local changes, verification and deferrals. A check-only result reports findings without claiming an upgrade. Commit, push, tag and publication remain separate requested endpoints.
