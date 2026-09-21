# Pi skill format and discovery

These rules describe Ling's embedded Pi resource loader. Read the installed SDK's `docs/skills.md` when checking a different version; the low-level `loadSkills` helper's default order alone does not describe application discovery.

## File format

```markdown
---
name: review-changes
description: "Review pending changes when asked to check a diff or find regressions."
---

# Review changes

Read the changed code and its callers. Use references/checklist.md for the detailed workflow.
```

| Field | Loader behavior |
| --- | --- |
| `name` | Defaults to the directory name when absent or empty. At most 64 characters: lowercase letters, digits, single hyphens, with no leading or trailing hyphen. Invalid names warn but can still load. Keep it equal to the directory name for stable invocation and switches. |
| `description` | Required nonblank string. Missing or invalid descriptions skip the skill; descriptions over 1024 characters warn. |
| `disable-model-invocation` | Only boolean `true` hides the skill from the automatic prompt. `/skill:<name>` remains available when skill commands are enabled. |
| Other fields | Do not grant tools or capabilities. Pi ignores fields such as `allowed-tools`. |

Use valid YAML frontmatter at the start of the file. Quote descriptions containing `: `; double a literal apostrophe inside a single-quoted YAML string. Keep descriptions and prose on one physical line for easy review; this is an authoring convention, not a Pi parser restriction.

A directory-form skill has `SKILL.md`. A missing description or malformed YAML in that file produces a load note. A root-level `.md` without skill frontmatter may be ignored as an ordinary document.

## Discovery and shadowing

Pi treats a directory containing `SKILL.md` as one skill and does not descend into its children looking for more skills. Otherwise it recurses. `.pi/skills` roots also accept direct `.md` files; `.agents/skills` auto-discovery uses skill directories. Dot-directories, `node_modules`, and ignored entries are skipped. Pi follows skill-root symlinks and deduplicates the same real file.

The normal resource loader prioritizes project-local roots, then user-local roots, then packages. Configured extra paths rank within their own scope before auto-discovered roots. Project `.pi/skills` precedes project/ancestor `.agents/skills`; user `<agent-dir>/skills` precedes `~/.agents/skills`. Ancestor `.agents/skills` discovery stops at the repository root. Project resources and project extras require trust. Explicit SDK/extension resources can add paths, so use the effective skill path and collision diagnostics to resolve an actual conflict.

First name wins. Duplicate names between Pi roots produce a collision note; Ling appends enabled built-ins last and silently omits a built-in when that name already exists. Project skills keep their scope even when installed in an extra path or supplied by a project package.

## Switches and resource previews

Global settings store `lingSkills.disabled` as skill names and `lingSkills.builtinEnabled` as the built-in master switch. A disabled non-project skill is absent from the system prompt and skill commands. Project-scoped skills are unaffected. Settings keeps configuration rows for disabled and built-in skills; the workspace Skills control shows the project's effective set.

Companion paths resolve relative to the skill directory. Ling lists `scripts/`, `references/`, and `assets/`, with at most three path components below each directory, for example `references/topic/detail.md`. The browser skips companion symlinks, reports truncated listings, previews `SKILL.md` up to 4 MiB and text companions up to 1 MiB, and identifies binary files without displaying them as text. These are UI preview limits, not Pi discovery limits or a sandbox on agent file tools.

Use Settings → Skills → Reload after manual changes to reconcile current projects and sessions. Switch and path mutations reload automatically. Inspect diagnostics and the reload result rather than treating a saved file or new session as proof that every existing session refreshed.
